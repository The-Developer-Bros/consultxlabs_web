/**
 * #837 — wallet-spend freeze, scoped to a single drifted BillingAccount.
 *
 * When the ledger-reconcile job finds WALLET_BALANCE_DRIFT (cached
 * `BillingAccount.walletBalance` ≠ the journal's WALLET account) the balance is
 * no longer trustworthy, so we must stop spending it until ops reconciles.
 *
 * There is no schema column for a per-wallet freeze and the launch schema is
 * frozen, so the freeze rides the existing append-only `SystemEvent` log rather
 * than a new column/table:
 *   - the freeze KEY is the indexed `correlationId` = `wallet-freeze:<billingAccountId>`,
 *   - the current state is the category of the LATEST event under that key
 *     (WALLET_FREEZE → frozen, WALLET_UNFREEZE → cleared).
 * FREEZE is set by the reconcile job; UNFREEZE is a manual ops action once the
 * drift is fixed. The check is a single indexed DB read inside the caller's tx,
 * so it fails CLOSED — an unreadable log blocks the spend rather than leaking it.
 *
 * #1205-triage — these writes are ERROR-PROPAGATING, unlike recordSystemEvent
 * (which swallows insert failures for operator surfaces). The freeze/unfreeze
 * pair IS the kill-switch state: a silently-dropped FREEZE leaves spend open;
 * a dropped UNFREEZE told the admin the account was released when it wasn't.
 *
 * Deliberately gates only discretionary SPEND (the checkout booking debit), not
 * chargeback recovery (app/api/webhooks/utils.ts): a lost-dispute debit recovers
 * money the bank already pulled and must not be stranded on a drift freeze.
 */

import { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";

const FREEZE_CATEGORY = "WALLET_FREEZE";
const UNFREEZE_CATEGORY = "WALLET_UNFREEZE";
const freezeKey = (billingAccountId: string) => `wallet-freeze:${billingAccountId}`;

export class WalletFrozenError extends Error {
  public readonly httpStatus = 409;
  constructor(public billingAccountId: string) {
    super(
      `Wallet spend frozen on billing account ${billingAccountId} pending ledger-drift resolution`,
    );
    this.name = "WalletFrozenError";
  }
}

/** True when the account's latest freeze event is a FREEZE. Reads inside the
 *  caller's tx/client so the check shares the spend's snapshot. */
export async function isWalletFrozen(
  db: Pick<typeof prisma, "systemEvent">,
  billingAccountId: string,
): Promise<boolean> {
  const latest = await db.systemEvent.findFirst({
    where: {
      correlationId: freezeKey(billingAccountId),
      category: { in: [FREEZE_CATEGORY, UNFREEZE_CATEGORY] },
    },
    orderBy: { createdAt: "desc" },
    select: { category: true },
  });
  return latest?.category === FREEZE_CATEGORY;
}

interface FreezeWriteParams {
  billingAccountId: string;
  organizationId?: string | null;
}

function freezeEventData(params: FreezeWriteParams & { reason: string }) {
  return {
    organizationId: params.organizationId ?? null,
    category: FREEZE_CATEGORY,
    severity: "ERROR" as const,
    message: `Wallet spend FROZEN for billing account ${params.billingAccountId}: ${params.reason}`,
    context: { billingAccountId: params.billingAccountId, reason: params.reason } as Prisma.InputJsonObject,
    correlationId: freezeKey(params.billingAccountId),
  };
}

/** Freeze wallet spend for one account. Idempotent — no-op if already frozen.
 *  Write failures PROPAGATE (see #1205-triage note above); the reconcile job's
 *  own error handling pages on them. Returns true when it wrote a new event. */
export async function freezeWalletSpend(params: FreezeWriteParams & {
  reason: string;
}): Promise<boolean> {
  if (await isWalletFrozen(prisma, params.billingAccountId)) return false;
  await prisma.systemEvent.create({ data: freezeEventData(params) });
  return true;
}

/** Unfreeze wallet spend for one account — the manual ops action the header
 *  above documents. Until this writer existed, a freeze was unrecoverable
 *  except by hand-inserting a SystemEvent row via raw SQL: the fail-closed
 *  read blocked every checkout for the org forever. Admin-gated route at
 *  app/api/admin/billing-accounts/[billingAccountId]/unfreeze.
 *
 *  #1205-triage — atomic under Serializable: the frozen-check and the
 *  UNFREEZE write share one tx, so a reconciler re-freezing concurrently
 *  (fresh drift discovered between our read and write) aborts us instead of
 *  being silently cleared by a later-dated UNFREEZE. Returns false (409 at
 *  the route) when not frozen or when the concurrent-write abort fires.
 *  Write failures propagate. */
export async function unfreezeWalletSpend(params: FreezeWriteParams & {
  actorUserId: string;
  reason: string;
}): Promise<boolean> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        if (!(await isWalletFrozen(tx, params.billingAccountId))) return false;
        await tx.systemEvent.create({
          data: {
            organizationId: params.organizationId ?? null,
            category: UNFREEZE_CATEGORY,
            severity: "INFO",
            message: `Wallet spend UNFROZEN for billing account ${params.billingAccountId} by ${params.actorUserId}: ${params.reason}`,
            context: {
              billingAccountId: params.billingAccountId,
              reason: params.reason,
              unfrozenBy: params.actorUserId,
            } as Prisma.InputJsonObject,
            correlationId: freezeKey(params.billingAccountId),
          },
        });
        return true;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (err) {
    // SSI abort = a concurrent freeze/unfreeze interleaved with us. Surface
    // as not-applied rather than throwing out of an admin route.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2034"
    ) {
      return false;
    }
    throw err;
  }
}
