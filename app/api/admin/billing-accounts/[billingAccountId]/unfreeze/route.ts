/**
 * POST /api/admin/billing-accounts/[billingAccountId]/unfreeze
 *
 * Manual ops release for a wallet-spend freeze (#837). The reconcile job
 * auto-FREEZES an org's wallet when the cached balance drifts from the
 * journal; once ops has reconciled the drift, this route writes the
 * WALLET_UNFREEZE SystemEvent that lifts the kill-switch. Before this
 * writer existed, unfreezing required hand-inserting a row via raw SQL —
 * a fail-closed control with no release path.
 *
 * Admin-only. Idempotent: unfreezing a non-frozen account is a 409, not
 * an error write. The freeze state is the category of the LATEST event
 * under `wallet-freeze:<billingAccountId>` (see lib/payments/wallet-freeze.ts).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/auth-helpers";
import {
  isWalletFrozen,
  unfreezeWalletSpend,
} from "@/lib/payments/wallet-freeze";

const BodySchema = z.object({
  reason: z.string().min(3).max(500),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ billingAccountId: string }> },
) {
  const auth = await requireAdminAuth();
  if (auth.error) return auth.error;

  const { billingAccountId } = await params;
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: body.error.flatten() },
      { status: 400 },
    );
  }

  const account = await prisma.billingAccount.findUnique({
    where: { id: billingAccountId },
    select: { id: true, ownerOrgId: true },
  });
  if (!account) {
    return NextResponse.json(
      { error: "Billing account not found" },
      { status: 404 },
    );
  }

  if (!(await isWalletFrozen(prisma, account.id))) {
    return NextResponse.json(
      { error: "Wallet spend is not frozen on this account" },
      { status: 409 },
    );
  }

  const applied = await unfreezeWalletSpend({
    billingAccountId: account.id,
    organizationId: account.ownerOrgId,
    actorUserId: auth.session.user.id,
    reason: body.data.reason,
  });

  // false ⇒ not frozen (raced with another actor or a concurrent re-freeze
  // abort) — surface as conflict, never report success for a no-op.
  if (!applied) {
    return NextResponse.json(
      { error: "Wallet spend is not frozen on this account" },
      { status: 409 },
    );
  }

  return NextResponse.json({ status: "unfrozen", billingAccountId: account.id });
}
