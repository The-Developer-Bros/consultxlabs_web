/**
 * @jest-environment node
 */

/**
 * Regression coverage for the PurchaseOrder balance invariant on the
 * `POST /api/organizations/[orgId]/billing-account/invoices` route and
 * its `PATCH /[invoiceId]` restoration counterpart.
 *
 * The invariant
 * -------------
 * When `body.purchaseOrderId` is set, the invoice MUST atomically
 * decrement `PurchaseOrder.remainingAmountPaise` and refuse with
 * `409 PO_BALANCE_EXCEEDED` if either the PO is non-ACTIVE or has
 * insufficient remaining budget. The route uses a CAS-style
 * `updateMany` predicate (`status: "ACTIVE"` + `remainingAmountPaise:
 * { gte: amount }`) so two concurrent POSTs against the same PO can
 * never both succeed beyond the PO's balance. On VOID / CANCELLED,
 * the PATCH restores the consumed budget by incrementing
 * `remainingAmountPaise` back. See enterprise-test-findings.txt PO.2 / PO.4.
 *
 * These cases pin the contract — the code itself lives at
 * `app/api/organizations/[orgId]/billing-account/invoices/route.ts:198-225`
 * (POST) and `[invoiceId]/route.ts:146-166` (PATCH restoration).
 */

import { NextRequest } from "next/server";

// ---- Mocks ------------------------------------------------------------

// The route applies moneyOpsLimiter (10/min). Without this stub, the real
// Upstash limiter 429s the later cases in CI — the same house mock every
// other enterprise suite uses (see owner-role-escalation-guard.test.ts).
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn().mockResolvedValue(null),
  moneyOpsLimiter: {},
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    organization: { findUnique: jest.fn() },
    purchaseOrder: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    contract: { findUnique: jest.fn() },
    organizationInvoice: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      // Status moves now go through the CAS helper (#476 audit): guarded
      // updateMany + in-tx findUniqueOrThrow re-read for the response body.
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    settlementLedgerEntry: { create: jest.fn() },
    orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
    // Why: the invoice POST route now emits an `invoice.issued` webhook
    // via dispatchWebhookEvent, which queries WebhookEndpoint then
    // optionally inserts OutboundWebhookDelivery rows. Stub both so the
    // dispatch helper short-circuits cleanly when no endpoints exist
    // (the canonical case for this test). Empty findMany → no createMany.
    webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
    outboundWebhookDelivery: { createMany: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(),
  orgRoleSatisfies: () => true,
}));

jest.mock("../../lib/compliance/gst", () => ({
  // Why: we don't want the GST math to be the test surface — invoke
  // with the totalPaise the test asks for so the assertions read like
  // the route handler sees them. Real GST resolution is covered by
  // its own suite.
  // Why: the route passes `{ subtotalPaise, supplierStateCode,
  // buyerStateCode, buyerCountry, hsnCode }` — NOT the raw items
  // array. Echo the subtotal back as the total so the CAS predicate
  // assertions read with the same number the caller supplied.
  deriveGstBreakdown: jest.fn(
    ({ subtotalPaise, hsnCode }: { subtotalPaise: number; hsnCode: string }) => ({
      subtotalPaise,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
      totalPaise: subtotalPaise,
      hsnCode,
      placeOfSupply: "06",
      reverseCharge: false,
    }),
  ),
}));

jest.mock("../../lib/payments/billing/invoice-numbering", () => ({
  generateOrgInvoiceNumber: jest.fn(async () => ({
    invoiceNumber: "ACME-2026-00001",
    fiscalYear: 2026,
  })),
}));

jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgInvoiceIssued: jest.fn(async () => {}),
}));

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { POST as createInvoice } from "@/app/api/organizations/[orgId]/billing-account/invoices/route";

// ---- Fixtures ---------------------------------------------------------

const mockedPrisma = prisma as unknown as {
  organization: { findUnique: jest.Mock };
  purchaseOrder: {
    findUnique: jest.Mock;
    updateMany: jest.Mock;
    update: jest.Mock;
  };
  contract: { findUnique: jest.Mock };
  organizationInvoice: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    findUniqueOrThrow: jest.Mock;
  };
  settlementLedgerEntry: { create: jest.Mock };
  orgAuditLog: { create: jest.Mock };
  $transaction: jest.Mock;
};
const mockedRequireOrgAccess = requireOrgAccess as jest.Mock;

function ownerAccess() {
  return {
    error: null,
    session: { user: { id: "u-owner", email: "owner@test.com" } },
    member: { id: "m-owner", role: "OWNER" },
    org: { id: "org-1", name: "Acme" },
  };
}

function makeRequest(body: unknown) {
  return new NextRequest(
    "http://localhost/api/organizations/org-1/billing-account/invoices",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    },
  );
}

function wireTxShim() {
  // Forward `tx` proxy to the same module-level Prisma mocks so the
  // route's tx.purchaseOrder.updateMany / tx.organizationInvoice.create
  // (POST) and tx.organizationInvoice.findFirst / tx.organizationInvoice.update
  // (PATCH) all land on jest.fn()s the tests can assert against.
  mockedPrisma.$transaction.mockImplementation(async (fn: unknown) => {
    const tx = {
      purchaseOrder: mockedPrisma.purchaseOrder,
      organizationInvoice: mockedPrisma.organizationInvoice,
      settlementLedgerEntry: mockedPrisma.settlementLedgerEntry,
      orgAuditLog: mockedPrisma.orgAuditLog,
      // Forwarded so `dispatchWebhookEvent` running inside the route's
      // transaction lands on the same module-level stubs.
      webhookEndpoint: (
        mockedPrisma as unknown as {
          webhookEndpoint: { findMany: jest.Mock };
        }
      ).webhookEndpoint,
      outboundWebhookDelivery: (
        mockedPrisma as unknown as {
          outboundWebhookDelivery: { createMany: jest.Mock };
        }
      ).outboundWebhookDelivery,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (fn as any)(tx);
  });
}

function setupOrg() {
  mockedPrisma.organization.findUnique.mockResolvedValue({
    id: "org-1",
    name: "Acme",
    slug: "acme",
    gstStateCode: "06",
    gstin: "06ABCDE1234F1Z5",
    hsnDefault: "9982",
    dataResidencyRegion: "IN",
    billingAccountId: "ba-1",
    invoiceNumberPrefix: "ACME",
  });
}

/**
 * The POST route runs a pre-flight `purchaseOrder.findUnique` BEFORE
 * starting the $transaction (to surface "PO belongs to another org" or
 * "PO is not ACTIVE" as a friendly 400/409 before any locks). Default
 * to a PO that passes both gates so each test only has to override the
 * CAS-step outcome via `updateMany.mockResolvedValue`.
 */
function setupActivePo(orgId = "org-1") {
  mockedPrisma.purchaseOrder.findUnique.mockResolvedValue({
    organizationId: orgId,
    status: "ACTIVE",
    // #1396 — the route now compares the PO's currency against the invoice's
    // before it claims any balance, and repeats the comparison in the CAS
    // predicate, so the pre-flight read has to carry it.
    currency: "INR",
  });
}

// ---- Tests ------------------------------------------------------------

describe("POST /api/organizations/[orgId]/billing-account/invoices — PO balance enforcement", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedRequireOrgAccess.mockResolvedValue(ownerAccess());
    setupOrg();
    setupActivePo();
    wireTxShim();
    mockedPrisma.organizationInvoice.create.mockResolvedValue({
      id: "inv-1",
      invoiceNumber: "ACME-2026-00001",
      totalPaise: 0,
    });
  });

  const paramsP = { params: Promise.resolve({ orgId: "org-1" }) };

  it("decrements PO balance and writes invoice when sufficient budget", async () => {
    // CAS succeeds → claim.count === 1 → invoice creation proceeds.
    mockedPrisma.purchaseOrder.updateMany.mockResolvedValue({ count: 1 });

    const res = await createInvoice(
      makeRequest({
        purchaseOrderId: "po-1",
        items: [{ description: "seats", quantity: 1, unitPrice: 5000 }],
        dueDate: "2026-06-30",
      }),
      paramsP,
    );

    expect(res.status).toBe(201);
    expect(mockedPrisma.purchaseOrder.updateMany).toHaveBeenCalledWith({
      where: {
        id: "po-1",
        organizationId: "org-1",
        status: "ACTIVE",
        currency: "INR",
        remainingAmountPaise: { gte: 5000 },
      },
      data: { remainingAmountPaise: { decrement: 5000 } },
    });
    expect(mockedPrisma.organizationInvoice.create).toHaveBeenCalled();
  });

  it("accepts an invoice that exactly drains the PO balance", async () => {
    // The route doesn't read the remaining balance — it lets the CAS
    // predicate be the gate. The simulated CAS hit (count = 1) proves
    // the route doesn't reject on equality.
    mockedPrisma.purchaseOrder.updateMany.mockResolvedValue({ count: 1 });

    const res = await createInvoice(
      makeRequest({
        purchaseOrderId: "po-1",
        items: [{ description: "wrap-up", quantity: 1, unitPrice: 5000 }],
        dueDate: "2026-06-30",
      }),
      paramsP,
    );
    expect(res.status).toBe(201);
  });

  it("rejects with 409 PO_BALANCE_EXCEEDED when CAS does not match", async () => {
    // Either remainingAmountPaise < amount OR status != ACTIVE.
    // updateMany matches no rows → count: 0 → route throws typed error.
    mockedPrisma.purchaseOrder.updateMany.mockResolvedValue({ count: 0 });

    const res = await createInvoice(
      makeRequest({
        purchaseOrderId: "po-1",
        items: [{ description: "overshoot", quantity: 1, unitPrice: 5001 }],
        dueDate: "2026-06-30",
      }),
      paramsP,
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      error: "PurchaseOrder balance insufficient or no longer ACTIVE",
      code: "PO_BALANCE_EXCEEDED",
    });
    // Critical: the invoice row must NOT have been created.
    expect(mockedPrisma.organizationInvoice.create).not.toHaveBeenCalled();
  });

  it("skips PO logic entirely when purchaseOrderId is absent", async () => {
    // A plain invoice (no PO) must not even touch purchaseOrder.updateMany.
    const res = await createInvoice(
      makeRequest({
        items: [{ description: "ad-hoc", quantity: 1, unitPrice: 2500 }],
        dueDate: "2026-06-30",
      }),
      paramsP,
    );
    expect(res.status).toBe(201);
    expect(mockedPrisma.purchaseOrder.updateMany).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/organizations/[orgId]/billing-account/invoices/[invoiceId] — PO balance restoration", () => {
  // The PATCH handler is its own route module; importing it lazily inside
  // the test keeps the POST suite above from accidentally importing the
  // detail-route's exports during module init.
  let patchHandler: typeof import("@/app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/route").PATCH;

  beforeAll(async () => {
    const mod = await import(
      "@/app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/route"
    );
    patchHandler = mod.PATCH;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedRequireOrgAccess.mockResolvedValue(ownerAccess());
    wireTxShim();
  });

  function patchParams(invoiceId = "inv-1") {
    return { params: Promise.resolve({ orgId: "org-1", invoiceId }) };
  }

  it("restores PO balance when an ISSUED invoice transitions to VOID", async () => {
    mockedPrisma.organizationInvoice.findFirst.mockResolvedValue({
      id: "inv-1",
      organizationId: "org-1",
      purchaseOrderId: "po-1",
      status: "ISSUED",
      totalPaise: 5000,
      invoiceNumber: "ACME-2026-00001",
      pdfStoragePath: null,
    });
    mockedPrisma.organizationInvoice.updateMany.mockResolvedValue({
      count: 1,
    });
    mockedPrisma.organizationInvoice.findUniqueOrThrow.mockResolvedValue({
      id: "inv-1",
      status: "VOID",
    });
    mockedPrisma.purchaseOrder.update.mockResolvedValue({ id: "po-1" });

    const req = new NextRequest(
      "http://localhost/api/organizations/org-1/billing-account/invoices/inv-1",
      {
        method: "PATCH",
        body: JSON.stringify({ status: "VOID" }),
        headers: { "Content-Type": "application/json" },
      },
    );
    const res = await patchHandler(req, patchParams());

    expect(res.status).toBe(200);
    expect(mockedPrisma.purchaseOrder.update).toHaveBeenCalledWith({
      where: { id: "po-1" },
      data: { remainingAmountPaise: { increment: 5000 } },
    });
  });

  it("does NOT restore PO balance when invoice has no purchase order", async () => {
    // Use ISSUED → VOID since that's the only allowed exit from ISSUED.
    // (DRAFT → CANCELLED would also work; the salient property is that no
    // PO is attached, so the route's restoration branch must be skipped.)
    mockedPrisma.organizationInvoice.findFirst.mockResolvedValue({
      id: "inv-2",
      organizationId: "org-1",
      purchaseOrderId: null,
      status: "ISSUED",
      totalPaise: 3000,
      invoiceNumber: "ACME-2026-00002",
      pdfStoragePath: null,
    });
    mockedPrisma.organizationInvoice.updateMany.mockResolvedValue({
      count: 1,
    });
    mockedPrisma.organizationInvoice.findUniqueOrThrow.mockResolvedValue({
      id: "inv-2",
      status: "VOID",
    });

    const req = new NextRequest(
      "http://localhost/api/organizations/org-1/billing-account/invoices/inv-2",
      {
        method: "PATCH",
        body: JSON.stringify({ status: "VOID" }),
        headers: { "Content-Type": "application/json" },
      },
    );
    const res = await patchHandler(req, patchParams("inv-2"));

    expect(res.status).toBe(200);
    expect(mockedPrisma.purchaseOrder.update).not.toHaveBeenCalled();
  });
});
