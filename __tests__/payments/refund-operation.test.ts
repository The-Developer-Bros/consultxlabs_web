/**
 * @jest-environment node
 */

/**
 * C1 — Canonical refund operation tests.
 *
 * Covers `refundPayment()` (app-initiated) and `applyRefundCascade()`
 * (gateway-cron-initiated) in `lib/payments/operations/refund.ts`.
 *
 * Strategy: stub the prisma client with a tiny in-memory state-machine
 * keyed off the test's seeded fixtures. We do NOT spin a real DB —
 * the cascade's logic (proportional split, last-leg-absorbs-remainder,
 * status flip thresholds, clawback gating) is pure math on top of the
 * model rows, and a faithful in-memory store is enough to exercise
 * every branch. Schema-level concerns (FK enforcement, Serializable
 * isolation) are validated separately by the integration suite.
 *
 * Each test seeds its own state (no cross-test leakage) by calling
 * `seed(state)` in `beforeEach`. The store mutates in place, so
 * assertions read straight off the same `state` object the cascade
 * modified.
 */

import type { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// In-memory prisma stub
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Store = {
  payments: Map<string, Row>;
  paymentLegs: Row[];
  refunds: Row[];
  disputes: Row[];
  consultantEarnings: Map<string, Row>;
  organizationEarnings: Map<string, Row>;
  organizationPayouts: Map<string, Row>;
  bookingUtilizations: Map<string, Row>; // keyed by paymentId
  usageLedgerEntries: Row[];
  programAssignments: Map<string, Row>;
  walletEntries: Row[];
  fundingLedgerEntries: Row[];
  billingAccounts: Map<string, Row>;
  organizationInvoices: Map<string, Row>;
  orgAuditLogs: Row[];
};

let state: Store;

function newStore(): Store {
  return {
    payments: new Map(),
    paymentLegs: [],
    refunds: [],
    disputes: [],
    consultantEarnings: new Map(),
    organizationEarnings: new Map(),
    organizationPayouts: new Map(),
    bookingUtilizations: new Map(),
    usageLedgerEntries: [],
    programAssignments: new Map(),
    walletEntries: [],
    fundingLedgerEntries: [],
    billingAccounts: new Map(),
    organizationInvoices: new Map(),
    orgAuditLogs: [],
  };
}

let uuidCounter = 0;
const stableUuid = (): string => `uuid-${++uuidCounter}`;

function txStub() {
  return {
    // #812 — the refund cascade now posts a balanced ledger txn inside the tx and
    // the ledger BLOCKS on failure, so the stub must satisfy postLedgerTxn:
    // idempotency miss → upsert accounts → create txn → upsert balance snapshot.
    // These are no-ops; the ledger journal itself is covered by ledger-specific
    // tests, not this cascade test.
    ledgerTransaction: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: stableUuid() })),
    },
    ledgerAccount: {
      upsert: jest.fn(async ({ where }: any) => ({ id: where.id })),
    },
    ledgerAccountBalance: {
      upsert: jest.fn(async () => ({})),
    },
    systemEvent: { create: jest.fn(async () => ({})) },
    // Referral-credit restoration now runs inside Phase 3b (it closes the #B20
    // gap where app-initiated refunds restored nothing). None of the fixtures
    // in this file are credit-funded, so an empty usage list is the correct
    // shape: reverseCreditsForPayment returns 0 immediately. Credit restoration
    // itself is covered by __tests__/referrals/service.test.ts.
    referralCreditUsage: {
      findMany: jest.fn(async () => []),
    },
    payment: {
      findUnique: jest.fn(async ({ where, select, include }: any) => {
        const p = state.payments.get(where.id);
        if (!p) return null;
        if (include) return hydratePayment(p);
        if (select) return projectSelect(hydratePayment(p), select);
        return p;
      }),
      findUniqueOrThrow: jest.fn(async ({ where, include }: any) => {
        const p = state.payments.get(where.id);
        if (!p) throw new Error(`Payment ${where.id} not found`);
        if (include) return hydratePayment(p);
        return p;
      }),
    },
    refund: {
      findMany: jest.fn(async ({ where, select }: any) => {
        const rows = state.refunds.filter((r) => {
          if (where.paymentId && r.paymentId !== where.paymentId) return false;
          if (where.status?.in && !where.status.in.includes(r.status))
            return false;
          return true;
        });
        if (select) return rows.map((r) => projectSelect(r, select));
        return rows;
      }),
      create: jest.fn(async ({ data }: any) => {
        const created = {
          id: stableUuid(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state.refunds.push(created);
        return created;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const r = state.refunds.find((x) => x.id === where.id);
        if (!r) throw new Error(`Refund ${where.id} not found`);
        Object.assign(r, data);
        return r;
      }),
      // #776 — applyRefundCascade's atomic idempotency claim (cascadedAt null→now).
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const r of state.refunds) {
          if (where.id && r.id !== where.id) continue;
          // cascadedAt: null matches an unset (undefined/null) stamp.
          if (where.cascadedAt === null && r.cascadedAt != null) continue;
          Object.assign(r, data);
          count++;
        }
        return { count };
      }),
    },
    // #785 — refundPayment now nets refundable against prior lost chargebacks.
    dispute: {
      aggregate: jest.fn(async ({ where }: any) => {
        const sum = state.disputes
          .filter(
            (d) =>
              d.paymentId === where.paymentId &&
              where.status?.in?.includes(d.status),
          )
          .reduce((acc, d) => acc + (d.amountPaise as number), 0);
        return { _sum: { amountPaise: sum } };
      }),
      // #1008 — live-dispute guard reads (outer + in-tx). notIn = terminal set.
      findFirst: jest.fn(async ({ where }: any) => {
        const notIn: string[] = where.status?.notIn ?? [];
        const d = state.disputes.find(
          (d) =>
            d.paymentId === where.paymentId &&
            !notIn.includes(d.status as string),
        );
        return d ?? null;
      }),
    },
    paymentLeg: {
      create: jest.fn(async ({ data }: any) => {
        const created = { id: stableUuid(), createdAt: new Date(), ...data };
        state.paymentLegs.push(created);
        return created;
      }),
      // #786 — mirrors @@unique([paymentId, source]): one reversal leg per
      // source; partials net via decrement.
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = where.paymentId_source;
        const existing = state.paymentLegs.find(
          (l) => l.paymentId === key.paymentId && l.source === key.source,
        );
        if (existing) {
          if (update.amountPaise?.decrement !== undefined) {
            existing.amountPaise =
              (existing.amountPaise as number) - update.amountPaise.decrement;
          } else if (update.amountPaise !== undefined) {
            existing.amountPaise = update.amountPaise;
          }
          return existing;
        }
        const created = { id: stableUuid(), createdAt: new Date(), ...create };
        state.paymentLegs.push(created);
        return created;
      }),
    },
    consultantEarnings: {
      update: jest.fn(async ({ where, data }: any) => {
        const e = state.consultantEarnings.get(where.id);
        if (!e) throw new Error(`ConsultantEarnings ${where.id} not found`);
        Object.assign(e, data);
        return e;
      }),
    },
    // #813 — recordTdsReversal reads/writes TDSRecord through the tx. Fixtures
    // here carry no payoutId so the helper is never invoked, but the surface
    // must exist for the gate to be callable without a TypeError.
    tDSRecord: {
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => ({ id: stableUuid(), ...data })),
    },
    organizationEarnings: {
      update: jest.fn(async ({ where, data }: any) => {
        const e = state.organizationEarnings.get(where.id);
        if (!e) throw new Error(`OrganizationEarnings ${where.id} not found`);
        Object.assign(e, data);
        return e;
      }),
    },
    organizationPayout: {
      update: jest.fn(async ({ where, data }: any) => {
        const p = state.organizationPayouts.get(where.id);
        if (!p) throw new Error(`OrganizationPayout ${where.id} not found`);
        if (data.clawbackAmountPaise?.increment !== undefined) {
          p.clawbackAmountPaise =
            (p.clawbackAmountPaise as number) +
            data.clawbackAmountPaise.increment;
        }
        if (data.clawbackInitiatedAt !== undefined) {
          p.clawbackInitiatedAt = data.clawbackInitiatedAt;
        }
        return p;
      }),
    },
    organizationInvoice: {
      findUnique: jest.fn(async ({ where, select }: any) => {
        const inv = state.organizationInvoices.get(where.id);
        if (!inv) return null;
        if (select) return projectSelect(inv, select);
        return inv;
      }),
    },
    // #1365 — the B2C credit-note mint probes both and no-ops when the payment
    // has no consumer invoice, which is true of every fixture in this suite.
    consumerCreditNote: { findUnique: jest.fn().mockResolvedValue(null) },
    consumerInvoice: { findUnique: jest.fn().mockResolvedValue(null) },
    orgAuditLog: {
      create: jest.fn(async ({ data }: any) => {
        const created = { id: stableUuid(), createdAt: new Date(), ...data };
        state.orgAuditLogs.push(created);
        return created;
      }),
    },
    bookingUtilization: {
      findUnique: jest.fn(async ({ where, select }: any) => {
        const u = state.bookingUtilizations.get(where.paymentId);
        if (!u) return null;
        if (select) return projectSelect(u, select);
        return u;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const u = state.bookingUtilizations.get(where.paymentId);
        if (!u) throw new Error("util not found");
        Object.assign(u, data);
        return u;
      }),
    },
    // #715/#716 — the cascade's overage credit-back step. These base tests
    // register no overage events, so findFirst→null / updateMany→0 rows.
    overageEvent: {
      findFirst: jest.fn(async () => null),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    programAssignment: {
      update: jest.fn(async ({ where, data }: any) => {
        const a = state.programAssignments.get(where.id);
        if (!a) throw new Error("assignment not found");
        if (data.engagementsUsed?.decrement !== undefined) {
          a.engagementsUsed =
            (a.engagementsUsed as number) - data.engagementsUsed.decrement;
        }
        if (data.overageCount?.decrement !== undefined) {
          a.overageCount =
            (a.overageCount as number) - data.overageCount.decrement;
        }
        return a;
      }),
    },
    usageLedgerEntry: {
      aggregate: jest.fn(async ({ where, _sum }: any) => {
        const rows = state.usageLedgerEntries.filter((r) => {
          if (where.paymentId && r.paymentId !== where.paymentId) return false;
          if (
            where.engagementsConsumed?.lt !== undefined &&
            !((r.engagementsConsumed as number) < where.engagementsConsumed.lt)
          )
            return false;
          return true;
        });
        const sum = rows.reduce(
          (acc, r) => acc + (r.engagementsConsumed as number),
          0,
        );
        return { _sum: { engagementsConsumed: sum } };
      }),
      create: jest.fn(async ({ data }: any) => {
        const created = { id: stableUuid(), createdAt: new Date(), ...data };
        state.usageLedgerEntries.push(created);
        return created;
      }),
    },
    walletEntry: {
      create: jest.fn(async ({ data }: any) => {
        const created = { id: stableUuid(), createdAt: new Date(), ...data };
        state.walletEntries.push(created);
        return created;
      }),
    },
    fundingLedgerEntry: {
      create: jest.fn(async ({ data }: any) => {
        const created = { id: stableUuid(), createdAt: new Date(), ...data };
        state.fundingLedgerEntries.push(created);
        return created;
      }),
    },
    billingAccount: {
      findUniqueOrThrow: jest.fn(async ({ where, select }: any) => {
        const a = state.billingAccounts.get(where.id);
        if (!a) throw new Error("billingAccount not found");
        if (select) return projectSelect(a, select);
        return a;
      }),
      // #776 — walletCredit now uses the ORM (atomic increment) instead of raw SQL.
      update: jest.fn(async ({ where, data, select }: any) => {
        const a = state.billingAccounts.get(where.id);
        if (!a) throw new Error("billingAccount not found");
        if (data.walletBalance?.increment !== undefined) {
          a.walletBalance =
            ((a.walletBalance as number) ?? 0) + data.walletBalance.increment;
        }
        if (data.walletBalance?.decrement !== undefined) {
          a.walletBalance =
            ((a.walletBalance as number) ?? 0) - data.walletBalance.decrement;
        }
        return select ? projectSelect(a, select) : a;
      }),
      // #776 — walletDebit now uses the ORM (atomic conditional decrement).
      updateMany: jest.fn(async ({ where, data }: any) => {
        const a = state.billingAccounts.get(where.id);
        if (!a) return { count: 0 };
        if (
          where.walletBalance?.gte !== undefined &&
          ((a.walletBalance as number) ?? -1) < where.walletBalance.gte
        ) {
          return { count: 0 };
        }
        if (data.walletBalance?.decrement !== undefined) {
          a.walletBalance =
            ((a.walletBalance as number) ?? 0) - data.walletBalance.decrement;
        }
        if (data.walletBalance?.increment !== undefined) {
          a.walletBalance =
            ((a.walletBalance as number) ?? 0) + data.walletBalance.increment;
        }
        return { count: 1 };
      }),
    },
    $executeRaw: jest.fn(async (..._parts: any[]) => {
      // walletCredit: increments BillingAccount.walletBalance.
      // We parse the template-literal to know which account by reading
      // the parameter list — Prisma passes interpolated values as
      // sequential args after the template-strings array. For our
      // tests we simply locate the BA by the only seeded id and bump
      // it; tests assert on the resulting balance.
      // The walletCredit helper passes (amountPaise, billingAccountId)
      // as the two interpolated values.
      const args = (_parts as any[]).slice(1);
      const amount = args[0] as number;
      const baId = args[1] as string;
      const acct = state.billingAccounts.get(baId);
      if (!acct) return 0;
      acct.walletBalance = ((acct.walletBalance as number) ?? 0) + amount;
      return 1;
    }),
  };
}

// Hydrate a payment with related rows for `include` queries.
function hydratePayment(p: Row): Row {
  return {
    ...p,
    legs: state.paymentLegs
      .filter((l) => l.paymentId === p.id)
      .sort(
        (a, b) =>
          (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime(),
      ),
    earnings: Array.from(state.consultantEarnings.values()).filter(
      (e) => e.paymentId === p.id,
    ),
    organizationEarnings: Array.from(state.organizationEarnings.values())
      .filter((e) => e.paymentId === p.id)
      .map((e) => ({
        ...e,
        orgPayout: e.orgPayoutId
          ? (state.organizationPayouts.get(e.orgPayoutId as string) ?? null)
          : null,
      })),
    bookingUtilization: state.bookingUtilizations.get(p.id as string) ?? null,
    refunds: state.refunds.filter((r) => r.paymentId === p.id),
  };
}

function projectSelect(row: Row, select: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) {
    if (!v) continue;
    out[k] = (row as Row)[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mock the prisma module — same client returned for both top-level + tx.
// ---------------------------------------------------------------------------

jest.mock("../../lib/prisma", () => {
  const stub = txStub();
  return {
    __esModule: true,
    default: {
      ...stub,
      // #812 — a real $transaction is atomic: a throw inside the callback MUST
      // roll back every write. The old `fn(stub)` mutated `state` in place with
      // no rollback, so a regression dropping refund.ts's `throw err` would still
      // pass. Snapshot `state` on entry, run the callback, and on throw restore
      // every collection IN PLACE (tests hold a live `state` reference), then
      // re-throw — mirroring Postgres rollback semantics.
      $transaction: async (fn: any) => {
        const snapshot = snapshotState();
        try {
          return await fn(stub);
        } catch (err) {
          restoreState(snapshot);
          throw err;
        }
      },
    },
  };
});

// structuredClone handles the store shape (Maps/arrays of plain objects with
// Date values — no functions), giving a detached snapshot of every collection.
function snapshotState(): Store {
  return structuredClone(state);
}

// Restore IN PLACE: clear + repopulate the SAME Map/array instances so the
// test's captured `state` reference still points at the rolled-back data.
function restoreState(snapshot: Store): void {
  for (const key of Object.keys(state) as Array<keyof Store>) {
    const live = state[key];
    const saved = snapshot[key];
    if (live instanceof Map) {
      live.clear();
      // forEach: tsconfig lacks downlevelIteration, so no for..of over Maps
      (saved as Map<string, Row>).forEach((v, k) => live.set(k, v));
    } else if (Array.isArray(live)) {
      live.length = 0;
      live.push(...(saved as Row[]));
    }
  }
}

// Audit-actions module is pure constants; no mock needed.

// ---------------------------------------------------------------------------
// Mock the gateway layer — refundPayment now calls the REAL gateway (M1). The
// default resolves an immediately-processed Razorpay refund so the existing
// cascade tests exercise the same synchronous path as before; individual
// tests override per-case (pending / declined / thrown).
// ---------------------------------------------------------------------------

const mockCreateGatewayRefund = jest.fn();
jest.mock("../../lib/payments", () => ({
  __esModule: true,
  createRefund: (...args: unknown[]) => mockCreateGatewayRefund(...args),
}));

// ---------------------------------------------------------------------------
// Imports under test (after the prisma mock is registered).
// ---------------------------------------------------------------------------

import {
  refundPayment,
  applyRefundCascade,
  RefundValidationError,
  RefundGatewayError,
} from "@/lib/payments/operations/refund";
import prisma from "@/lib/prisma";

const tx: any = prisma; // the stub IS the tx in our setup

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedSinglePartyWalletPayment({
  paymentId = "pay-1",
  amount = 10000,
  consultantSharePaise = 8000,
  orgShare = 1000,
  platformFeePaise = 1000,
  billingAccountId = "ba-1",
  organizationId = "org-1" as string | null,
  ownerOrgId = "org-1",
  walletBalance = 50000,
  withOrgEarnings = true,
  orgEarningsStatus = "PENDING" as const,
}: Partial<{
  paymentId: string;
  amount: number;
  consultantSharePaise: number;
  orgShare: number;
  platformFeePaise: number;
  billingAccountId: string;
  // null = B2C booking funded by an org wallet without an org tag on the
  // Payment row — the #835 invisible path.
  organizationId: string | null;
  ownerOrgId: string;
  walletBalance: number;
  withOrgEarnings: boolean;
  orgEarningsStatus: "PENDING" | "PAID";
}>) {
  state.payments.set(paymentId, {
    id: paymentId,
    amount,
    originalAmount: amount,
    // #812 — realistic payments always carry taxAmount (0 here); omitting it made
    // the refund posting's gstRev NaN and the (now-blocking) ledger reject it.
    taxAmount: 0,
    currency: "INR",
    paymentStatus: "SUCCEEDED",
    paymentGateway: "RAZORPAY",
    paymentIntent: "pay_intent_seed",
    displayCurrencyAtCheckout: null,
    exchangeRateAtCheckout: null,
    organizationId,
    billingAccountId,
    billableToOrgInvoiceId: null,
  });
  state.paymentLegs.push({
    id: "leg-w-1",
    paymentId,
    source: "WALLET",
    amountPaise: amount,
    sourceRef: "asg-1",
    createdAt: new Date(),
  });
  state.consultantEarnings.set("ce-1", {
    id: "ce-1",
    paymentId,
    consultantProfileId: "cp-1",
    consultantSharePaise,
    grossAmount: amount,
    platformFeePaise,
    refundedShareAmount: 0,
    status: "PENDING",
  });
  if (withOrgEarnings) {
    state.organizationEarnings.set("oe-1", {
      id: "oe-1",
      paymentId,
      organizationId,
      grossAmountPaise: amount,
      platformFeePaise: platformFeePaise,
      orgSharePaise: orgShare,
      consultantSharePaise: consultantSharePaise,
      refundedAmountPaise: 0,
      status: orgEarningsStatus,
      orgPayoutId: null,
    });
  }
  state.billingAccounts.set(billingAccountId, {
    id: billingAccountId,
    walletBalance,
    currency: "INR",
    ownerOrgId,
  });
}

beforeEach(() => {
  state = newStore();
  uuidCounter = 0;
  jest.clearAllMocks();
  mockCreateGatewayRefund.mockResolvedValue({
    refundId: "rfnd_gw_1",
    amount: 0,
    currency: "INR",
    status: "SUCCEEDED",
  });
});

// ===========================================================================
// Tests
// ===========================================================================

describe("refundPayment — full single-leg WALLET refund", () => {
  it("reverses leg, credits wallet, marks ConsultantEarnings + OrganizationEarnings REFUNDED", async () => {
    seedSinglePartyWalletPayment({});

    const result = await refundPayment({
      paymentId: "pay-1",
      reason: "customer-request",
      initiatedByUserId: "user-admin",
    });

    expect(result.amountRefundedPaise).toBe(10000);
    expect(result.legsReversed).toBe(1);
    expect(result.consultantEarningsReversed).toBe(1);
    expect(result.organizationEarningsReversed).toBe(1);
    expect(result.clawbackInitiated).toBe(false);

    // Wallet credited.
    expect(state.billingAccounts.get("ba-1")?.walletBalance).toBe(60000);
    // ConsultantEarnings fully refunded.
    const ce = state.consultantEarnings.get("ce-1");
    expect(ce?.refundedShareAmount).toBe(8000);
    expect(ce?.status).toBe("REFUNDED");
    // OrganizationEarnings fully refunded.
    const oe = state.organizationEarnings.get("oe-1");
    // #776 — refundedAmountPaise tracks the ORG share only (org-payout nets it
    // against orgSharePaise; the consultant slice lives on ConsultantEarnings).
    expect(oe?.refundedAmountPaise).toBe(1000); // org share only
    expect(oe?.status).toBe("REFUNDED");
    // Refund row flipped to SUCCEEDED.
    expect(state.refunds[0]?.status).toBe("SUCCEEDED");
  });

  it("#835 — emits a WALLET/WALLET_REFUND OrgAuditLog row on the wallet-leg branch", async () => {
    seedSinglePartyWalletPayment({});

    await refundPayment({
      paymentId: "pay-1",
      reason: "customer-request",
      initiatedByUserId: "user-admin",
    });

    const walletRows = state.orgAuditLogs.filter(
      (r) => r.category === "WALLET" && r.action === "WALLET_REFUND",
    );
    expect(walletRows).toHaveLength(1);
    expect(walletRows[0].organizationId).toBe("org-1");
    const details = walletRows[0].details as Record<string, unknown>;
    expect(details.paymentId).toBe("pay-1");
    expect(details.amountPaise).toBe(10000);
    expect(details.balanceAfterPaise).toBe(60000);
    expect(details.initiatedByUserId).toBe("user-admin");
  });
});

describe("refundPayment — #835 org-wallet-funded B2C payment with NO org tag", () => {
  // The original invisible path: Payment.organizationId is null but the
  // wallet belongs to an org — the audit row must resolve the org via
  // BillingAccount.ownerOrgId.
  it("resolves the org from BillingAccount.ownerOrgId when payment.organizationId is null", async () => {
    seedSinglePartyWalletPayment({
      organizationId: null,
      ownerOrgId: "org-wallet-owner",
      withOrgEarnings: false,
    });

    await refundPayment({
      paymentId: "pay-1",
      reason: "customer-request",
    });

    const walletRows = state.orgAuditLogs.filter(
      (r) => r.category === "WALLET" && r.action === "WALLET_REFUND",
    );
    expect(walletRows).toHaveLength(1);
    expect(walletRows[0].organizationId).toBe("org-wallet-owner");
    // No org tag on the payment ⇒ Step 8's INVOICE row must NOT fire; the
    // WALLET row is the only org-audit artifact of this refund.
    expect(
      state.orgAuditLogs.filter((r) => r.category === "INVOICE"),
    ).toHaveLength(0);
  });
});

describe("refundPayment — multi-collaborator refund balances the ledger (#813 comment)", () => {
  // Proves the Gemini "rounding imbalance" comment is a false alarm: consRev IS
  // Σ proportion(consultantSharePaise) (Math.floor), and the per-collaborator
  // debits are exactly those same floored proportions, so they sum to consRev
  // and the posting balances — even for awkward shares + an odd partial refund.
  // The real postLedgerTxn runs here; an imbalance would throw and the cascade
  // would roll back, so a successful refund == a balanced posting.
  function seedMultiCollaborator() {
    state.payments.set("pay-mc", {
      id: "pay-mc",
      amount: 10000,
      originalAmount: 10000,
      taxAmount: 0,
      currency: "INR",
      paymentStatus: "SUCCEEDED",
      paymentGateway: "RAZORPAY",
      paymentIntent: "pay_intent_seed",
      displayCurrencyAtCheckout: null,
      exchangeRateAtCheckout: null,
      organizationId: null,
      billingAccountId: "ba-mc",
      billableToOrgInvoiceId: null,
    });
    state.paymentLegs.push({
      id: "leg-mc",
      paymentId: "pay-mc",
      source: "WALLET",
      amountPaise: 10000,
      sourceRef: "asg-mc",
      createdAt: new Date(),
    });
    // Three collaborators with deliberately awkward shares (sum 8000), platform
    // fee 2000 → gross 10000.
    const shares: Array<[string, string, number, string]> = [
      ["ce-mc-1", "cp-1", 4001, "OWNER"],
      ["ce-mc-2", "cp-2", 3333, "COLLABORATOR"],
      ["ce-mc-3", "cp-3", 666, "COLLABORATOR"],
    ];
    for (const [id, cp, share, role] of shares) {
      state.consultantEarnings.set(id, {
        id,
        paymentId: "pay-mc",
        consultantProfileId: cp,
        consultantSharePaise: share,
        grossAmount: role === "OWNER" ? 10000 : 0,
        platformFeePaise: role === "OWNER" ? 2000 : 0,
        role,
        refundedShareAmount: 0,
        status: "PENDING",
      });
    }
    state.billingAccounts.set("ba-mc", {
      id: "ba-mc",
      walletBalance: 50000,
      currency: "INR",
    });
  }

  it("an odd partial refund across 3 collaborators completes without LedgerImbalanceError", async () => {
    seedMultiCollaborator();
    // 3334/10000 forces a non-clean floor on every collaborator's proportion.
    const result = await refundPayment({
      paymentId: "pay-mc",
      amountPaise: 3334,
      reason: "multi-collab partial",
    });
    // If the posting imbalanced, postLedgerTxn would have thrown and rolled the
    // cascade back; reaching here with all three reversed proves it balanced.
    expect(result.amountRefundedPaise).toBe(3334);
    expect(result.consultantEarningsReversed).toBe(3);
    expect(
      state.consultantEarnings.get("ce-mc-1")?.refundedShareAmount,
    ).toBeGreaterThan(0);
    expect(
      state.consultantEarnings.get("ce-mc-2")?.refundedShareAmount,
    ).toBeGreaterThan(0);
    expect(
      state.consultantEarnings.get("ce-mc-3")?.refundedShareAmount,
    ).toBeGreaterThan(0);
  });

  it("a full multi-collaborator refund also balances", async () => {
    seedMultiCollaborator();
    const result = await refundPayment({
      paymentId: "pay-mc",
      reason: "multi-collab full",
    });
    expect(result.amountRefundedPaise).toBe(10000);
    expect(result.consultantEarningsReversed).toBe(3);
  });

  // #812 — the invariant test: if the ledger posting fails, the WHOLE cascade
  // must roll back. This is the test that goes RED if anyone reverts refund.ts's
  // `throw err` in the cascade's catch (half-applied earnings/legs with no
  // balanced journal). We inject the failure at postLedgerTxn's create call.
  it("rolls back the entire cascade when the ledger posting throws (atomicity invariant)", async () => {
    seedMultiCollaborator();
    // postLedgerTxn: findUnique (miss) → ledgerAccount.upsert → ledgerTransaction.create.
    // Fail the create exactly once → the cascade's catch re-throws → tx rolls back.
    (tx.ledgerTransaction.create as jest.Mock).mockRejectedValueOnce(
      new Error("simulated ledger write failure"),
    );

    await expect(
      refundPayment({ paymentId: "pay-mc", reason: "ledger-fail" }),
    ).rejects.toThrow("simulated ledger write failure");

    // Every cascade write must be undone (TDS path omitted — owned by a
    // concurrent change; this asserts the ledger/legs/earnings/wallet rollback).
    // ConsultantEarnings.refundedShareAmount back to 0 for all collaborators.
    for (const id of ["ce-mc-1", "ce-mc-2", "ce-mc-3"]) {
      expect(state.consultantEarnings.get(id)?.refundedShareAmount).toBe(0);
      expect(state.consultantEarnings.get(id)?.status).toBe("PENDING");
    }
    // Wallet credit reversed — balance back to the seeded 50000.
    expect(state.billingAccounts.get("ba-mc")?.walletBalance).toBe(50000);
    // No wallet-credit entry persisted.
    expect(state.walletEntries).toHaveLength(0);
    // No leg reversal persisted — only the original WALLET leg remains.
    expect(state.paymentLegs).toHaveLength(1);
    expect(state.paymentLegs[0]?.id).toBe("leg-mc");
    // M1 three-phase semantics: the gateway ALREADY moved the money, so the
    // Refund row must SURVIVE the cascade rollback — PENDING, bound to the
    // real gateway id, cascadedAt reverted — so the webhook redelivery /
    // backstop cron re-drive the cascade durably.
    expect(state.refunds).toHaveLength(1);
    expect(state.refunds[0]?.status).toBe("PENDING");
    expect(state.refunds[0]?.refundId).toBe("rfnd_gw_1");
    expect(state.refunds[0]?.cascadedAt ?? null).toBeNull();
    // Payment row untouched (no amountRefundedPaise written by the cascade).
    expect(state.payments.get("pay-mc")?.amountRefundedPaise).toBeUndefined();
  });
});

describe("refundPayment — M1 gateway wiring", () => {
  it("calls the gateway before marking SUCCEEDED and binds the gateway refund id", async () => {
    seedSinglePartyWalletPayment({});

    const result = await refundPayment({
      paymentId: "pay-1",
      reason: "customer request",
      initiatedByUserId: "admin-1",
    });

    expect(mockCreateGatewayRefund).toHaveBeenCalledTimes(1);
    expect(mockCreateGatewayRefund).toHaveBeenCalledWith({
      paymentIntentId: "pay_intent_seed",
      amount: 10000,
      reason: "customer request",
      // The Phase-1 reservation id doubles as the gateway idempotency key, so a
      // retry replays the original refund instead of debiting the payer twice.
      idempotencyKey: state.refunds[0]?.id,
      // #676 B1 — the same id rides the gateway notes so webhooks/reconcile
      // can bind the gateway refund back to its reservation exactly.
      metadata: { reservationId: state.refunds[0]?.id },
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.gatewayRefundId).toBe("rfnd_gw_1");
    expect(state.refunds).toHaveLength(1);
    expect(state.refunds[0]?.refundId).toBe("rfnd_gw_1");
    expect(state.refunds[0]?.status).toBe("SUCCEEDED");
    expect(state.refunds[0]?.cascadedAt).toBeTruthy();
  });

  it("release #1014 review — gateway metadata MERGES into the row, preserving Phase-1 audit keys", async () => {
    seedSinglePartyWalletPayment({});
    // Razorpay always returns notes (reason at minimum), so this is the
    // every-refund path, not an edge case.
    mockCreateGatewayRefund.mockResolvedValueOnce({
      refundId: "rfnd_gw_meta",
      amount: 10000,
      currency: "INR",
      status: "SUCCEEDED",
      metadata: { reason: "customer request", gw_key: "gw_val" },
    });

    await refundPayment({
      paymentId: "pay-1",
      reason: "customer request",
      initiatedByUserId: "admin-1",
    });

    const meta = state.refunds[0]?.metadata as Record<string, unknown>;
    // Phase-1 keys survive the gateway-id binding...
    expect(meta.initiatedByUserId).toBe("admin-1");
    expect(meta.source).toBe("app");
    // ...and the gateway keys land alongside them.
    expect(meta.gw_key).toBe("gw_val");
    expect(meta.reason).toBe("customer request");
  });

  it("release #1014 review — falsy gateway id keeps the pending_ placeholder and omits gatewayRefundId", async () => {
    seedSinglePartyWalletPayment({});
    mockCreateGatewayRefund.mockResolvedValueOnce({
      refundId: "",
      amount: 10000,
      currency: "INR",
      status: "PENDING",
    });

    const result = await refundPayment({
      paymentId: "pay-1",
      reason: "id-less gateway ack",
    });

    expect(result.status).toBe("PENDING");
    // Contract: absent, never "".
    expect(result.gatewayRefundId).toBeUndefined();
    // Row keeps the placeholder the reconcile cron matches on.
    expect(String(state.refunds[0]?.refundId)).toMatch(/^pending_/);
  });

  it("gateway throw keeps a pending_ placeholder, runs NO cascade, and surfaces RefundGatewayError", async () => {
    seedSinglePartyWalletPayment({});
    mockCreateGatewayRefund.mockRejectedValueOnce(
      new Error("gateway unreachable"),
    );

    await expect(
      refundPayment({ paymentId: "pay-1", reason: "net-down" }),
    ).rejects.toThrow(RefundGatewayError);

    expect(state.refunds).toHaveLength(1);
    const row = state.refunds[0];
    // Placeholder id is what reconcile-pending-refunds matches on.
    expect(String(row?.refundId)).toMatch(/^pending_/);
    expect(row?.status).toBe("PENDING");
    expect(row?.cascadedAt ?? null).toBeNull();
    // No money-side effects ran.
    expect(state.consultantEarnings.get("ce-1")?.refundedShareAmount).toBe(0);
    expect(state.billingAccounts.get("ba-1")?.walletBalance).toBe(50000);
    expect(state.paymentLegs).toHaveLength(1);
  });

  it("gateway-PENDING refund defers the cascade to the webhook path (no double-post)", async () => {
    seedSinglePartyWalletPayment({});
    mockCreateGatewayRefund.mockResolvedValueOnce({
      refundId: "rfnd_gw_slow",
      amount: 10000,
      currency: "INR",
      status: "PENDING",
    });

    const result = await refundPayment({
      paymentId: "pay-1",
      reason: "slow gateway",
    });

    expect(result.status).toBe("PENDING");
    expect(result.legsReversed).toBe(0);
    const row = state.refunds[0];
    expect(row?.refundId).toBe("rfnd_gw_slow"); // webhook finds it by THIS id
    expect(row?.status).toBe("PENDING");
    expect(row?.cascadedAt ?? null).toBeNull();
    expect(state.consultantEarnings.get("ce-1")?.refundedShareAmount).toBe(0);

    // Webhook-style completion: the cascade applies exactly once against the
    // SAME row — and a second application no-ops on the cascadedAt claim.
    const first = await applyRefundCascade(tx, {
      paymentId: "pay-1",
      refundId: String(row?.id),
      amountPaise: 10000,
      reason: "Gateway refund",
      initiatedByUserId: null,
    });
    expect(first.legsReversed).toBeGreaterThan(0);
    const second = await applyRefundCascade(tx, {
      paymentId: "pay-1",
      refundId: String(row?.id),
      amountPaise: 10000,
      reason: "Gateway refund",
      initiatedByUserId: null,
    });
    expect(second.legsReversed).toBe(0);
  });

  it("gateway-declined refund marks the row FAILED and restores the refundable balance", async () => {
    seedSinglePartyWalletPayment({});
    mockCreateGatewayRefund.mockResolvedValueOnce({
      refundId: "rfnd_gw_declined",
      amount: 10000,
      currency: "INR",
      status: "FAILED",
    });

    await expect(
      refundPayment({ paymentId: "pay-1", reason: "declined" }),
    ).rejects.toMatchObject({
      name: "RefundGatewayError",
      code: "GATEWAY_REFUND_DECLINED",
    });

    const row = state.refunds[0];
    expect(row?.status).toBe("FAILED");
    expect(row?.failureReason).toBeTruthy();
    expect(row?.failedAt).toBeTruthy();
    expect(state.consultantEarnings.get("ce-1")?.refundedShareAmount).toBe(0);

    // FAILED rows don't consume the refundable balance — a retry succeeds.
    const retry = await refundPayment({ paymentId: "pay-1", reason: "retry" });
    expect(retry.status).toBe("SUCCEEDED");
  });
});

describe("refundPayment — partial 50% refund proportional split", () => {
  it("splits proportional, leaves earnings non-REFUNDED", async () => {
    seedSinglePartyWalletPayment({
      amount: 10000,
      consultantSharePaise: 8000,
      orgShare: 1000,
    });

    const result = await refundPayment({
      paymentId: "pay-1",
      amountPaise: 5000, // 50%
      reason: "partial-refund",
    });

    expect(result.amountRefundedPaise).toBe(5000);
    expect(state.billingAccounts.get("ba-1")?.walletBalance).toBe(55000);

    const ce = state.consultantEarnings.get("ce-1");
    expect(ce?.refundedShareAmount).toBe(4000); // 50% of 8000
    expect(ce?.status).toBe("PENDING"); // not fully refunded

    const oe = state.organizationEarnings.get("oe-1");
    // #776 — org share only: floor(1000 × 5000/10000) = 500.
    expect(oe?.refundedAmountPaise).toBe(500);
    expect(oe?.status).toBe("PENDING");
  });
});

describe("refundPayment — multi-leg WALLET + REFERRAL_CREDIT", () => {
  it("reverses each leg proportionally, last leg absorbs remainder", async () => {
    state.payments.set("pay-2", {
      id: "pay-2",
      amount: 10001, // odd amount forces a remainder
      originalAmount: 10001,
      taxAmount: 0, // #812 — realistic payments carry taxAmount
      currency: "INR",
      paymentStatus: "SUCCEEDED",
      paymentGateway: "RAZORPAY",
      paymentIntent: "pay_intent_seed",
      displayCurrencyAtCheckout: null,
      exchangeRateAtCheckout: null,
      organizationId: null,
      billingAccountId: "ba-2",
      billableToOrgInvoiceId: null,
    });
    state.paymentLegs.push(
      {
        id: "leg-w-2",
        paymentId: "pay-2",
        source: "WALLET",
        amountPaise: 7001,
        sourceRef: "asg-2",
        createdAt: new Date(2026, 0, 1),
      },
      {
        id: "leg-rc-1",
        paymentId: "pay-2",
        source: "REFERRAL_CREDIT",
        amountPaise: 3000,
        sourceRef: "rcu-1",
        createdAt: new Date(2026, 0, 2),
      },
    );
    state.billingAccounts.set("ba-2", {
      id: "ba-2",
      walletBalance: 0,
      currency: "INR",
      ownerOrgId: "org-1",
    });

    const result = await refundPayment({
      paymentId: "pay-2",
      reason: "full",
    });

    expect(result.amountRefundedPaise).toBe(10001);
    expect(result.legsReversed).toBe(2);
    // Wallet credited with the wallet leg's full original amount (last
    // leg absorbs remainder; in this case the WALLET leg appears first
    // chronologically but the cascade picks up the *last* positive leg
    // for the remainder, which is the REFERRAL_CREDIT leg. So the
    // wallet credit is exactly floor(7001 * 10001 / 10001) = 7001.
    expect(state.billingAccounts.get("ba-2")?.walletBalance).toBe(7001);
    // #835 — exactly one WALLET audit row: the REFERRAL_CREDIT leg must
    // not produce one.
    expect(
      state.orgAuditLogs.filter(
        (r) => r.category === "WALLET" && r.action === "WALLET_REFUND",
      ),
    ).toHaveLength(1);
  });
});

describe("refundPayment — clawback when payout already COMPLETED", () => {
  it("increments OrganizationPayout.clawbackAmountPaise and stamps clawbackInitiatedAt", async () => {
    seedSinglePartyWalletPayment({ orgEarningsStatus: "PAID" });
    // Promote the org earnings: link to a COMPLETED payout.
    state.organizationPayouts.set("op-1", {
      id: "op-1",
      organizationId: "org-1",
      status: "COMPLETED",
      clawbackAmountPaise: 0,
      clawbackInitiatedAt: null,
    });
    const oe = state.organizationEarnings.get("oe-1")!;
    oe.orgPayoutId = "op-1";

    const before = Date.now();
    const result = await refundPayment({
      paymentId: "pay-1",
      reason: "post-payout-refund",
    });

    expect(result.clawbackInitiated).toBe(true);
    const op = state.organizationPayouts.get("op-1")!;
    expect(op.clawbackAmountPaise).toBe(1000); // = orgShare
    expect(op.clawbackInitiatedAt).toBeInstanceOf(Date);
    expect((op.clawbackInitiatedAt as Date).getTime()).toBeGreaterThanOrEqual(
      before,
    );

    // PAYOUT_CLAWBACK audit row written.
    const audit = state.orgAuditLogs.find(
      (l) => l.action === "PAYOUT_CLAWBACK",
    );
    expect(audit).toBeDefined();
    expect((audit?.details as any)?.clawbackAmountPaise).toBe(1000);
  });

  it("preserves earliest clawbackInitiatedAt across multiple partial refunds", async () => {
    seedSinglePartyWalletPayment({ orgEarningsStatus: "PAID" });
    const firstStamp = new Date(2026, 0, 1);
    state.organizationPayouts.set("op-1", {
      id: "op-1",
      organizationId: "org-1",
      status: "COMPLETED",
      clawbackAmountPaise: 200,
      clawbackInitiatedAt: firstStamp,
    });
    state.organizationEarnings.get("oe-1")!.orgPayoutId = "op-1";

    await refundPayment({
      paymentId: "pay-1",
      amountPaise: 5000,
      reason: "second-clawback",
    });

    const op = state.organizationPayouts.get("op-1")!;
    expect(op.clawbackAmountPaise).toBe(200 + 500); // 50% of orgShare
    expect(op.clawbackInitiatedAt).toBe(firstStamp); // not overwritten
  });
});

describe("refundPayment — validation guards", () => {
  it("rejects refund > refundable", async () => {
    seedSinglePartyWalletPayment({ amount: 10000 });
    await expect(
      refundPayment({ paymentId: "pay-1", amountPaise: 99999, reason: "x" }),
    ).rejects.toBeInstanceOf(RefundValidationError);
  });

  it("#785 rejects a refund after a lost chargeback already pulled the full amount", async () => {
    seedSinglePartyWalletPayment({ amount: 10000 });
    // a lost chargeback already reversed the whole payment via the dispute path
    state.disputes.push({
      paymentId: "pay-1",
      amountPaise: 10000,
      status: "LOST",
    });
    await expect(
      refundPayment({
        paymentId: "pay-1",
        amountPaise: 10000,
        reason: "double",
      }),
    ).rejects.toBeInstanceOf(RefundValidationError);
  });

  it("#785 allows a refund up to the un-charged-back remainder", async () => {
    seedSinglePartyWalletPayment({ amount: 10000 });
    state.disputes.push({
      paymentId: "pay-1",
      amountPaise: 6000,
      status: "LOST",
    });
    // refundable = 10000 − 6000 chargeback = 4000
    const result = await refundPayment({
      paymentId: "pay-1",
      amountPaise: 4000,
      reason: "remainder",
    });
    expect(result.amountRefundedPaise).toBe(4000);
  });

  it("rejects refund on non-SUCCEEDED payment", async () => {
    seedSinglePartyWalletPayment({});
    state.payments.get("pay-1")!.paymentStatus = "PENDING";
    await expect(
      refundPayment({ paymentId: "pay-1", reason: "x" }),
    ).rejects.toBeInstanceOf(RefundValidationError);
  });

  it("rejects refund on missing payment", async () => {
    await expect(
      refundPayment({ paymentId: "missing", reason: "x" }),
    ).rejects.toBeInstanceOf(RefundValidationError);
  });

  it("rejects refund on already-fully-refunded payment", async () => {
    seedSinglePartyWalletPayment({ amount: 10000 });
    state.refunds.push({
      id: "r-existing",
      paymentId: "pay-1",
      // #772 renamed Refund.amount → amountPaise; refund.ts sums r.amountPaise.
      // Seeding the old field left the "already refunded" sum NaN → guard never
      // tripped. Use the live field name.
      amountPaise: 10000,
      status: "SUCCEEDED",
    });
    await expect(
      refundPayment({ paymentId: "pay-1", reason: "x" }),
    ).rejects.toBeInstanceOf(RefundValidationError);
  });
});

describe("refundPayment — #778 §C-1 negative platform plug posts, never skips", () => {
  // Referral-credit shape: earnings were allocated off originalAmount (10000)
  // while funding legs carry the post-credit amount (8000). On a full refund
  // the reversed shares (8500) exceed the funding credits (8000) → plug −500.
  // The pre-#812 code silently SKIPPED the journal here (EARNINGS_LEDGER_DRIFT
  // the reconciler could not repair); the fix posts a balancing PLATFORM_FEE
  // CREDIT and a failure rolls the cascade back. This test pins the posting.
  it("posts a balanced txn with a PLATFORM_FEE credit absorbing the negative plug", async () => {
    state.payments.set("pay-neg", {
      id: "pay-neg",
      amount: 8000,
      originalAmount: 10000,
      taxAmount: 0,
      currency: "INR",
      paymentStatus: "SUCCEEDED",
      paymentGateway: "RAZORPAY",
      paymentIntent: "pay_intent_seed",
      displayCurrencyAtCheckout: null,
      exchangeRateAtCheckout: null,
      organizationId: null,
      billingAccountId: "ba-neg",
      billableToOrgInvoiceId: null,
    });
    state.paymentLegs.push({
      id: "leg-neg",
      paymentId: "pay-neg",
      source: "WALLET",
      amountPaise: 8000,
      sourceRef: "asg-neg",
      createdAt: new Date(),
    });
    state.consultantEarnings.set("ce-neg", {
      id: "ce-neg",
      paymentId: "pay-neg",
      consultantProfileId: "cp-neg",
      consultantSharePaise: 8500, // allocated off originalAmount
      grossAmount: 10000,
      platformFeePaise: 1500,
      refundedShareAmount: 0,
      status: "PENDING",
    });
    state.billingAccounts.set("ba-neg", {
      id: "ba-neg",
      walletBalance: 50000,
      currency: "INR",
    });

    const result = await refundPayment({
      paymentId: "pay-neg",
      reason: "negative-plug full refund",
    });
    expect(result.amountRefundedPaise).toBe(8000);

    // The journal was POSTED (not skipped) and balances including the plug:
    // Cr WALLET 8000 + Cr PLATFORM_FEE 500 vs Dr CONSULTANT_PAYABLE 8500.
    const txnCreates = (tx.ledgerTransaction.create as jest.Mock).mock.calls;
    expect(txnCreates.length).toBeGreaterThan(0);
    const refundTxn = txnCreates
      .map((c: any[]) => c[0]?.data)
      .find((d: any) => d?.idempotencyKey?.startsWith("refund:"));
    expect(refundTxn).toBeDefined();
    const entries: Array<{
      accountId: string;
      direction: string;
      amountPaise: number | bigint;
    }> = refundTxn.entries.create;
    const plugEntry = entries.find(
      (e) => e.accountId.includes("PLATFORM_FEE") && e.direction === "CREDIT",
    );
    expect(plugEntry).toBeDefined();
    expect(Number(plugEntry!.amountPaise)).toBe(500);
    const total = (dir: string) =>
      entries
        .filter((e) => e.direction === dir)
        .reduce((s, e) => s + Number(e.amountPaise), 0);
    expect(total("DEBIT")).toBe(total("CREDIT"));
  });
});

describe("applyRefundCascade — #786 reversal legs for unbilled accruals", () => {
  function seedInvoiceFundedPayment(amount = 10000) {
    state.payments.set("pay-inv", {
      id: "pay-inv",
      amount,
      originalAmount: amount,
      taxAmount: 0,
      currency: "INR",
      paymentStatus: "SUCCEEDED",
      paymentGateway: "RAZORPAY",
      paymentIntent: "pay_intent_seed",
      displayCurrencyAtCheckout: null,
      exchangeRateAtCheckout: null,
      organizationId: "org-1",
      billingAccountId: "ba-1",
      billableToOrgInvoiceId: null, // unbilled — the #786 case
    });
    state.paymentLegs.push({
      id: "leg-inv-1",
      paymentId: "pay-inv",
      source: "INVOICE_ACCRUAL",
      amountPaise: amount,
      sourceRef: "asg-1",
      createdAt: new Date(),
    });
    state.consultantEarnings.set("ce-inv", {
      id: "ce-inv",
      paymentId: "pay-inv",
      consultantProfileId: "cp-1",
      consultantSharePaise: 8000,
      grossAmount: amount,
      platformFeePaise: 1000,
      refundedShareAmount: 0,
      status: "PENDING",
    });
    state.organizationEarnings.set("oe-inv", {
      id: "oe-inv",
      paymentId: "pay-inv",
      organizationId: "org-1",
      grossAmountPaise: amount,
      platformFeePaise: 1000,
      orgSharePaise: 1000,
      consultantSharePaise: 8000,
      refundedAmountPaise: 0,
      status: "PENDING",
      orgPayoutId: null,
    });
    state.billingAccounts.set("ba-1", {
      id: "ba-1",
      walletBalance: 0,
      currency: "INR",
    });
  }

  it("appends ONE negative reversal sibling and never mutates the original leg", async () => {
    seedInvoiceFundedPayment(10000);
    state.refunds.push({
      id: "r-1",
      paymentId: "pay-inv",
      amount: 4000,
      status: "SUCCEEDED",
      refundId: "rfnd_1",
    });

    await applyRefundCascade(tx, {
      paymentId: "pay-inv",
      refundId: "r-1",
      amountPaise: 4000,
      reason: "partial-1",
    });

    const original = state.paymentLegs.find(
      (l) => l.paymentId === "pay-inv" && l.source === "INVOICE_ACCRUAL",
    );
    const reversals = state.paymentLegs.filter(
      (l) =>
        l.paymentId === "pay-inv" && l.source === "INVOICE_ACCRUAL_REVERSAL",
    );
    expect(original?.amountPaise).toBe(10000); // immutable
    expect(reversals).toHaveLength(1);
    expect(reversals[0]?.amountPaise).toBe(-4000);
    expect(reversals[0]?.sourceRef).toBe("asg-1"); // pairs with the original
  });

  it("second partial refund nets into the existing reversal leg (no P2002 second row)", async () => {
    seedInvoiceFundedPayment(10000);
    state.refunds.push(
      {
        id: "r-1",
        paymentId: "pay-inv",
        amount: 4000,
        status: "SUCCEEDED",
        refundId: "rfnd_1",
      },
      {
        id: "r-2",
        paymentId: "pay-inv",
        amount: 6000,
        status: "SUCCEEDED",
        refundId: "rfnd_2",
      },
    );

    await applyRefundCascade(tx, {
      paymentId: "pay-inv",
      refundId: "r-1",
      amountPaise: 4000,
      reason: "partial-1",
    });
    await applyRefundCascade(tx, {
      paymentId: "pay-inv",
      refundId: "r-2",
      amountPaise: 6000,
      reason: "partial-2",
    });

    const original = state.paymentLegs.find(
      (l) => l.paymentId === "pay-inv" && l.source === "INVOICE_ACCRUAL",
    );
    const reversals = state.paymentLegs.filter(
      (l) =>
        l.paymentId === "pay-inv" && l.source === "INVOICE_ACCRUAL_REVERSAL",
    );
    expect(original?.amountPaise).toBe(10000); // still immutable
    expect(reversals).toHaveLength(1); // netted, not duplicated
    expect(reversals[0]?.amountPaise).toBe(-10000); // -(4000 + 6000)
  });
});

describe("applyRefundCascade — gateway-cron entry path", () => {
  it("runs cascade against an existing Refund row without creating one", async () => {
    seedSinglePartyWalletPayment({});
    // Seed an existing Refund (gateway-created via webhook).
    state.refunds.push({
      id: "r-gateway",
      paymentId: "pay-1",
      amount: 10000,
      status: "SUCCEEDED",
      refundId: "rfnd_xyz",
    });

    const refundsBefore = state.refunds.length;
    const result = await applyRefundCascade(tx, {
      paymentId: "pay-1",
      refundId: "r-gateway",
      amountPaise: 10000,
      reason: "gateway-refund",
    });

    expect(state.refunds).toHaveLength(refundsBefore); // no new Refund row
    expect(result.consultantEarningsReversed).toBe(1);
    expect(result.organizationEarningsReversed).toBe(1);
    expect(state.consultantEarnings.get("ce-1")?.status).toBe("REFUNDED");
  });
});
