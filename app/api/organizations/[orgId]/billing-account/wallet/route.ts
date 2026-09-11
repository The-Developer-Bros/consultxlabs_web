/**
 * GET /api/organizations/[orgId]/billing-account/wallet
 *
 * Read-only wallet snapshot: current balance + paginated ledger. Only
 * returns data when the BillingAccount is in WALLET funding mode — for
 * INVOICE or LICENSE orgs the wallet isn't meaningful, so callers get
 * a 404 rather than a zero-balance ghost response.
 *
 * Top-ups go through the sibling /top-ups route. Refunds come from the
 * /api/payments/refunds webhook path and end up as WalletEntry rows
 * with reason=REFUND.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { ledgerAccountId } from "@/lib/payments/ledger/post";
import {
  signedDeltaPaise,
  withRunningBalance,
} from "@/lib/api/organizations/wallet";

const LedgerQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "billing.read",
    canSponsor: true,
  });
  if (access.error) return access.error;

  const ba = await prisma.billingAccount.findFirst({
    where: { ownerOrgId: orgId },
    select: {
      id: true,
      fundingSource: true,
      currency: true,
      walletBalance: true,
      // #777 §C — balance-alert config surfaced so the wallet tab can render
      // its config section off the same fetch.
      minBalancePaise: true,
      autoTopUpEnabled: true,
      autoTopUpAmountPaise: true,
    },
  });
  if (!ba) {
    return NextResponse.json(
      { error: "Organization does not have a BillingAccount" },
      { status: 404 },
    );
  }
  if (ba.fundingSource !== "WALLET") {
    return NextResponse.json(
      {
        error: "Wallet is only available for WALLET-funded accounts",
        currentFundingSource: ba.fundingSource,
      },
      { status: 409 },
    );
  }

  const url = new URL(req.url);
  const parsed = LedgerQuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid pagination", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { page, perPage } = parsed.data;

  // #772 B3 — wallet history is now the double-entry journal: the org's
  // WALLET LedgerAccount holds one entry per cash movement (CREDIT = top-up
  // / refund-in, DEBIT = booking spend / top-up refund-out). We surface a
  // WalletEntry-compatible shape (signed deltaPaise + reason) so the client
  // ledger view is unchanged.
  // #783 — INR-only ledger; the WALLET account is keyed INR by every posting,
  // so read it the same way (keying by ba.currency would miss a non-INR org's
  // history now that the postings omit currency).
  const walletAccountId = ledgerAccountId({
    kind: "WALLET",
    organizationId: orgId,
  });
  const skip = (page - 1) * perPage;
  // `createdAt` alone is not a total order — two postings in one transaction
  // share a timestamp — so paging on it can repeat or drop a row, and a running
  // balance computed over an unstable order is simply wrong. `id` breaks the
  // tie, and every query below sorts identically so they agree about which
  // entries are "newer".
  const ledgerOrder = [{ createdAt: "desc" as const }, { id: "desc" as const }];
  const [total, entries, directionTotals] = await prisma.$transaction([
    prisma.ledgerEntry.count({ where: { accountId: walletAccountId } }),
    prisma.ledgerEntry.findMany({
      where: { accountId: walletAccountId },
      orderBy: ledgerOrder,
      skip,
      take: perPage,
      include: {
        transaction: {
          select: { kind: true, paymentId: true, description: true },
        },
      },
    }),
    prisma.ledgerEntry.groupBy({
      by: ["direction"],
      where: { accountId: walletAccountId },
      _sum: { amountPaise: true },
    }),
  ]);

  // The client's ledger table renders a "Balance" column, and nothing has ever
  // produced the field: see withRunningBalance for what that cost. Anchor on
  // the journal-derived balance and walk backwards through the page.
  const journalBalance = signedDeltaPaise(
    directionTotals.map((g) => ({
      direction: g.direction,
      amountPaise: g._sum.amountPaise ?? 0,
    })),
  );
  const newerDelta =
    skip === 0
      ? 0
      : signedDeltaPaise(
          await prisma.ledgerEntry.findMany({
            where: { accountId: walletAccountId },
            orderBy: ledgerOrder,
            take: skip,
            select: { direction: true, amountPaise: true },
          }),
        );

  const ledger = withRunningBalance(
    entries.map((e) => ({
      id: e.id,
      deltaPaise:
        e.direction === "CREDIT"
          ? Number(e.amountPaise)
          : -Number(e.amountPaise),
      reason: e.transaction.kind,
      paymentId: e.transaction.paymentId,
      notes: e.transaction.description,
      createdAt: e.createdAt,
    })),
    journalBalance - newerDelta,
  );

  return NextResponse.json({
    billingAccount: {
      id: ba.id,
      currency: ba.currency,
      walletBalance: ba.walletBalance ?? 0,
      minBalancePaise: ba.minBalancePaise,
      autoTopUpEnabled: ba.autoTopUpEnabled,
      autoTopUpAmountPaise: ba.autoTopUpAmountPaise,
    },
    ledger,
    meta: { total, page, perPage },
  });
}
