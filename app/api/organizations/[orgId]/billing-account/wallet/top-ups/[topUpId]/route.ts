/**
 * GET /api/organizations/[orgId]/billing-account/wallet/top-ups/[topUpId]
 *
 * `topUpId` is the top-up idempotency key (`we_<uuid>`) returned by
 * `POST /top-ups` as `topUpId` and persisted as
 * `WalletTopUp.providerOrderId @unique` — NOT the Razorpay order id
 * (`order_<…>`). The two ids are minted in the same POST and share
 * `notes.walletEntryOrderId` on the gateway side, but only the top-up
 * id is safe to expose in URLs (the Razorpay id is gateway state).
 *
 * Used by the client post-checkout to poll for "did the webhook
 * confirm my top-up yet?" without exposing the whole ledger.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; topUpId: string }>;
  },
) {
  const { orgId, topUpId } = await params;
  const access = await requireOrgAccess(orgId, { minimumRole: "MANAGER", canSponsor: true });
  if (access.error) return access.error;

  // `topUpId` is stored as WalletTopUp.providerOrderId (see the file
  // header). Scope the lookup by billing-account ownership so a stolen
  // id from another tenant can't leak state.
  const topUp = await prisma.walletTopUp.findFirst({
    where: {
      providerOrderId: topUpId,
      billingAccount: { ownerOrgId: orgId },
    },
  });
  if (!topUp) {
    return NextResponse.json({ error: "Top-up not found" }, { status: 404 });
  }

  // WalletTopUp.status carries the lifecycle directly: PENDING until the
  // webhook confirms, then CONFIRMED; FAILED if the gateway rejected.
  const status =
    topUp.status === "CONFIRMED"
      ? "confirmed"
      : topUp.status === "FAILED"
        ? "failed"
        : "pending";
  return NextResponse.json({
    topUp: {
      topUpId: topUp.providerOrderId,
      providerPaymentId: topUp.providerPaymentId,
      status,
      amountPaise: topUp.amountPaise,
      createdAt: topUp.createdAt,
    },
  });
}
