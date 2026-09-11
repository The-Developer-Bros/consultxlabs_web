import type { Tx } from "@/lib/prisma";
/**
 * #778 elegance — the OverageEvent chargeStatus state machine, in one guarded
 * transition. Deliberately dependency-light (Prisma types only) so the metering
 * + settlement call sites can import it without dragging in heavy graphs
 * (Novu/notifications live in `overage-settlement.ts`).
 *
 * Lifecycle (one-way; corrections are new events / counter-entries, never
 * mutations of charged rows):
 *
 *   PENDING ─┬─▶ ACCRUED ──▶ CHARGED        (CHARGE_ORG: rollup → invoice paid)
 *            ├─▶ CHARGED                     (CHARGE_MEMBER: gateway webhook)
 *            ├─▶ FAILED ──▶ PENDING          (CHARGE_MEMBER: abandon → retry)
 *            └─▶ REVERSED                     (booking refunded)
 *   FAILED ──▶ CHARGED                       (late capture webhook recovers a
 *                                             sweep-FAILed charge that was paid)
 *   ACCRUED / FAILED ──▶ REVERSED            (refund of an un-charged overage)
 *   CHARGED ──▶ REVERSED                     (credit-back on full refund: the
 *                                             CHARGE_MEMBER side-payment is
 *                                             refunded / the CHARGE_ORG invoice
 *                                             is netted by a credit note —
 *                                             #715/#716, stamps reversedAt)
 *   BLOCKED ──▶ (terminal)                   set at creation only
 */
import type { OverageChargeStatus, Prisma } from "@prisma/client";

// The only from-states each target may be reached from. Baked into the update
// WHERE so an illegal transition (e.g. re-charging a REVERSED event, or
// downgrading a CHARGED one) simply matches zero rows — the guard IS the filter.
const ALLOWED_FROM: Record<OverageChargeStatus, OverageChargeStatus[]> = {
  PENDING: ["FAILED"], // member retry after an abandoned side-charge
  ACCRUED: ["PENDING"], // CHARGE_ORG rolled onto an issued invoice
  CHARGED: ["PENDING", "ACCRUED", "FAILED"], // money collected (member webhook / invoice paid); FAILED→CHARGED recovers a charge the abandoned-sweep wrongly FAILed while its capture webhook was stuck (#785)
  FAILED: ["PENDING"], // member side-charge abandoned
  // uncollected reversal (booking refunded before collection) OR post-collection
  // credit-back on full refund (#715/#716). Callers pass fromIn to disambiguate:
  // the uncollected path (reverseBookingUtilization) narrows to non-CHARGED; the
  // credit-back path (refund cascade) narrows to CHARGED + stamps reversedAt.
  REVERSED: ["PENDING", "ACCRUED", "FAILED", "CHARGED"],
  BLOCKED: [], // set at creation only
};

/**
 * Guarded chargeStatus transition. `where` selects the event(s) (by id,
 * paymentId, bookingUtilization, …); the allowed-from guard is appended so only
 * legal transitions take effect. Returns the number of rows moved.
 */
export async function transitionOverage(
  // Only needs the overageEvent delegate — narrowed so every client shape
  // (Tx, the cap-helper's Tx, or the root client) fits.
  tx: Pick<Tx, "overageEvent">,
  where: Prisma.OverageEventWhereInput,
  to: OverageChargeStatus,
  data?: {
    paymentId?: string | null;
    invoiceLineItemId?: string | null;
    settledAt?: Date | null;
    /** #715/#716 — stamped when a CHARGED overage is credited back on refund. */
    reversedAt?: Date | null;
    /** #779 §A telemetry — why a FAILED write-off happened (sweep/timeout). */
    chargeFailureReason?: string | null;
  },
  opts?: {
    /**
     * #812 — narrow the guard to a subset of the legal from-states
     * (intersected with ALLOWED_FROM, never widened). Lets a caller learn
     * WHICH edge fired: FAILED→CHARGED must re-carve basePaise, while
     * PENDING→CHARGED must not — and a read-then-check would race.
     */
    fromIn?: OverageChargeStatus[];
  },
): Promise<number> {
  const allowedFrom = opts?.fromIn
    ? opts.fromIn.filter((s) => ALLOWED_FROM[to].includes(s))
    : ALLOWED_FROM[to];
  const res = await tx.overageEvent.updateMany({
    where: { ...where, chargeStatus: { in: allowedFrom } },
    data: { chargeStatus: to, ...data },
  });
  return res.count;
}
