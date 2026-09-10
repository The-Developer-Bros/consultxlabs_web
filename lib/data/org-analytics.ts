/**
 * Shared analytics aggregate read for an organization.
 *
 * Extracted from GET /api/organizations/[orgId]/analytics so the route and
 * the org home + analytics server pages' SSR prefetch read through one code
 * path — the SSR cache and the CSR fetch can't drift. Auth stays at the call
 * site: the route enforces requireOrgAccess; the prefetch runs under the
 * dashboard layout's gate.
 *
 * Returns a fully plain/JSON-safe object (no Date, no bigint — money fields
 * pass through sumPaise) so it crosses the RSC→client boundary and React Query
 * hydration applies verbatim.
 */

import type { FundingSource, MemberRole, OrgStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import { ledgerAccountId } from "@/lib/payments/ledger/post";
import { sumPaise } from "@/lib/payments/utils/money";
import { resolveActivationSignals } from "@/lib/enterprise/org-activation-signals";
import { ENABLE_HOST_ORGS } from "@/lib/feature-flags";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface OrgAnalyticsPayload {
  status: OrgStatus;
  capabilities: {
    canSponsor: boolean;
    canHost: boolean;
    fundingSource: FundingSource | null;
    walletBalance: number | null;
    currency: string | null;
  };
  activation: Awaited<ReturnType<typeof resolveActivationSignals>>;
  members: {
    total: number;
    active: number;
    byRole: Array<{ role: MemberRole; count: number }>;
  };
  programs: {
    total: number;
    active: number;
    activeAssignments: number;
  };
  wallet: {
    balancePaise: number;
    recent: Array<{ reason: string; count: number; deltaPaise: number }>;
  } | null;
  invoices: {
    outstandingCount: number;
    outstandingPaise: number;
    pastDueCount: number;
    paidLast30dCount: number;
    paidLast30dPaise: number;
  } | null;
  subscription: {
    model: "PER_SEAT" | "FLAT_FEE";
    cycle: "MONTHLY" | "QUARTERLY" | "ANNUAL";
    flatFeePaise: number | null;
  } | null;
  reimbursements: {
    last30dCount: number;
    last30dPaise: number;
  } | null;
  earnings: Array<{
    status: string;
    count: number;
    orgSharePaise: number;
    refundedPaise: number;
  }> | null;
}

/** `null` when the org row doesn't exist (route maps this to a 404). */
export async function getOrgAnalytics(
  orgId: string,
): Promise<OrgAnalyticsPayload | null> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      status: true,
      canSponsor: true,
      canHost: true,
      billingAccount: {
        select: { id: true, fundingSource: true, walletBalance: true, currency: true },
      },
    },
  });
  if (!org) return null;

  const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS_MS);
  // Same row as the include above: BillingAccount.ownerOrgId is a @unique
  // 1:1 back-reference to Organization.billingAccountId, so this is the
  // identical account — no separate round-trip needed. (Was a serial
  // findFirst that added one DB hop to every org home/analytics render.)
  const baId = org.billingAccount ? { id: org.billingAccount.id } : null;

  const [
    memberAggregate,
    memberByRole,
    programTotal,
    activeAssignments,
    recentWallet,
    outstandingInvoiceAgg,
    paidInvoiceAgg,
    pastDueInvoiceCount,
    earningsAggregate,
    licenseSubscription,
    reimbursementAgg,
    activationSignals,
  ] = await Promise.all([
    prisma.membership.groupBy({
      by: ["status"],
      where: { organizationId: orgId },
      _count: { _all: true },
    }),
    prisma.membership.groupBy({
      by: ["role"],
      where: { organizationId: orgId, status: "ACTIVE" },
      _count: { _all: true },
    }),
    prisma.program.groupBy({
      by: ["status"],
      where: { contract: { organizationId: orgId } },
      _count: { _all: true },
    }),
    prisma.programAssignment.count({
      where: {
        program: { contract: { organizationId: orgId } },
        periodEnd: { gte: new Date() },
      },
    }),
    // #772 B3 — wallet activity derives from the double-entry journal: group the
    // org's WALLET-account entries (last 30d) by originating txn kind and sum the
    // signed delta (CREDIT = +, DEBIT = −), preserving the {reason,count,deltaPaise}
    // shape. ORM read + JS aggregation (no raw SQL): the 30-day window per org is
    // bounded, so pulling the entries and folding them in app code is fine.
    org.billingAccount?.fundingSource === "WALLET" &&
    baId &&
    org.billingAccount.currency
      ? (async (): Promise<
          Array<{ reason: string; count: number; deltaPaise: number | null }>
        > => {
          const entries = await prisma.ledgerEntry.findMany({
            where: {
              // #783 — INR-only ledger; WALLET is keyed INR by every posting.
              accountId: ledgerAccountId({
                kind: "WALLET",
                organizationId: orgId,
              }),
              createdAt: { gte: thirtyDaysAgo },
            },
            select: {
              direction: true,
              amountPaise: true,
              transaction: { select: { kind: true } },
            },
          });
          // #780 — extended-client reads surface amountPaise as number.
          const byKind = new Map<string, { count: number; delta: number }>();
          for (const e of entries) {
            const kind = e.transaction.kind;
            const cur = byKind.get(kind) ?? { count: 0, delta: 0 };
            cur.count += 1;
            cur.delta +=
              e.direction === "CREDIT" ? e.amountPaise : -e.amountPaise;
            byKind.set(kind, cur);
          }
          return Array.from(byKind.entries()).map(([reason, v]) => ({
            reason,
            count: v.count,
            deltaPaise: v.delta,
          }));
        })()
      : Promise.resolve(
          [] as Array<{
            reason: string;
            count: number;
            deltaPaise: number | null;
          }>,
        ),
    org.billingAccount?.fundingSource === "INVOICE" && baId
      ? prisma.organizationInvoice.aggregate({
          where: {
            billingAccountId: baId.id,
            status: { in: ["ISSUED", "OVERDUE"] },
          },
          _sum: { totalPaise: true },
          _count: { _all: true },
        })
      : Promise.resolve(null),
    org.billingAccount?.fundingSource === "INVOICE" && baId
      ? prisma.organizationInvoice.aggregate({
          where: {
            billingAccountId: baId.id,
            status: "PAID",
            paidAt: { gte: thirtyDaysAgo },
          },
          _sum: { totalPaise: true },
          _count: { _all: true },
        })
      : Promise.resolve(null),
    org.billingAccount?.fundingSource === "INVOICE" && baId
      ? prisma.organizationInvoice.count({
          where: {
            billingAccountId: baId.id,
            status: "OVERDUE",
          },
        })
      : Promise.resolve(0),
    // Honesty gate (#687): with ENABLE_HOST_ORGS off no new splits accrue, so
    // don't surface host earnings even if canHost is still set on the row.
    ENABLE_HOST_ORGS && org.canHost
      ? prisma.organizationEarnings.groupBy({
          by: ["status"],
          where: { organizationId: orgId },
          _sum: { orgSharePaise: true, refundedAmountPaise: true },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    // BillingSubscription is set up by the LICENSE contract create flow
    // (see app/api/organizations/[orgId]/contracts/route.ts). For LICENSE
    // orgs we surface it so the home Get-Started checklist can mark
    // "Configure billing settings" done once a fee has been captured.
    org.billingAccount?.fundingSource === "LICENSE" && baId
      ? prisma.billingSubscription.findUnique({
          where: { billingAccountId: baId.id },
          select: { id: true, model: true, cycle: true, flatFeePaise: true },
        })
      : Promise.resolve(null),
    // PERSONAL-funded orgs: org-tagged SUCCEEDED payments in the last
    // 30d (members paid out of pocket). Drives the /home reimbursement
    // summary card — full report lives at /reimbursements. (#714)
    org.billingAccount?.fundingSource === "PERSONAL"
      ? prisma.payment.aggregate({
          where: {
            organizationId: orgId,
            paymentStatus: "SUCCEEDED",
            createdAt: { gte: thirtyDaysAgo },
          },
          _sum: { amount: true },
          _count: { _all: true },
        })
      : Promise.resolve(null),
    // #777 §A / #779 §F — the extra signals (contract / KYB / contract-expiring /
    // pending-overage / stuck-payout / credit cap-near) the home action-center
    // needs but the tiles above don't already carry.
    resolveActivationSignals(orgId),
  ]);

  const memberTotal = memberAggregate.reduce(
    (acc, s) => acc + s._count._all,
    0,
  );
  const memberActive =
    memberAggregate.find((s) => s.status === "ACTIVE")?._count._all ?? 0;

  const programActive =
    programTotal.find((p) => p.status === "ACTIVE")?._count._all ?? 0;
  const programTotalCount = programTotal.reduce(
    (acc, s) => acc + s._count._all,
    0,
  );

  return {
    status: org.status,
    capabilities: {
      canSponsor: org.canSponsor,
      canHost: org.canHost,
      fundingSource: org.billingAccount?.fundingSource ?? null,
      walletBalance: org.billingAccount?.walletBalance ?? null,
      currency: org.billingAccount?.currency ?? null,
    },
    activation: activationSignals,
    members: {
      total: memberTotal,
      active: memberActive,
      byRole: memberByRole.map((r) => ({
        role: r.role,
        count: r._count._all,
      })),
    },
    programs: {
      total: programTotalCount,
      active: programActive,
      activeAssignments,
    },
    wallet:
      org.billingAccount?.fundingSource === "WALLET"
        ? {
            balancePaise: org.billingAccount.walletBalance ?? 0,
            recent: recentWallet.map((r) => ({
              reason: r.reason,
              count: Number(r.count),
              deltaPaise: Number(r.deltaPaise ?? 0),
            })),
          }
        : null,
    invoices:
      org.billingAccount?.fundingSource === "INVOICE"
        ? {
            outstandingCount: outstandingInvoiceAgg?._count._all ?? 0,
            // #780 — _sum bypasses the result extension: bigint until sumPaise'd.
            outstandingPaise: sumPaise(outstandingInvoiceAgg?._sum.totalPaise),
            pastDueCount: pastDueInvoiceCount,
            paidLast30dCount: paidInvoiceAgg?._count._all ?? 0,
            paidLast30dPaise: sumPaise(paidInvoiceAgg?._sum.totalPaise),
          }
        : null,
    subscription: licenseSubscription
      ? {
          model: licenseSubscription.model,
          cycle: licenseSubscription.cycle,
          flatFeePaise: licenseSubscription.flatFeePaise,
        }
      : null,
    reimbursements: reimbursementAgg
      ? {
          last30dCount: reimbursementAgg._count._all,
          last30dPaise: sumPaise(reimbursementAgg._sum.amount),
        }
      : null,
    // Honesty gate (#687): mirror the query gate above — flag off ⇒ null, not
    // an empty array, so a still-canHost row doesn't imply zeroed host earnings.
    earnings: ENABLE_HOST_ORGS && org.canHost
      ? earningsAggregate.map((e) => ({
          status: e.status,
          count: e._count._all,
          orgSharePaise: sumPaise(e._sum.orgSharePaise),
          refundedPaise: sumPaise(e._sum.refundedAmountPaise),
        }))
      : null,
  };
}
