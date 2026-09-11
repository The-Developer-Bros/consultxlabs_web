import type { Tx } from "@/lib/prisma";
/**
 * #812 §P0 / #775 / #782 — basePaise carve bookkeeping for CHARGE_MEMBER
 * overage side-charges.
 *
 * At booking time, overage-settlement carves the over-cap pass-through
 * (basePaise) OUT of the parent payment's INVOICE_ACCRUAL leg — the org pays
 * only the covered portion; the member's side-charge collects base +
 * surcharge. Until #812 the three abandon paths (gateway failure, abandoned
 * sweep, 14-day timeout) FAILed the side-charge without putting basePaise
 * back, silently under-billing the org for a session its member consumed.
 *
 * restore = FAILED: give the parent accrual its basePaise back so the next
 * invoice rollup bills the org correctly. recarve = the recovery edges
 * (FAILED→PENDING retry, FAILED→CHARGED late capture): take it out again so
 * the member's payment doesn't double-collect with the org's invoice.
 *
 * Both are gated by the caller's CAS transition (run ONLY when the claim
 * matched a row), which makes them exactly-once per edge. If the parent was
 * already rolled onto an invoice (billableToOrgInvoiceId set), touching the
 * leg would silently diverge from the issued document — those cases return
 * "invoiced" and the caller surfaces a SystemEvent / 409 instead.
 *
 * Dependency-light (Prisma types only) so the sweep jobs can import it.
 */

export type CarveOutcome = "restored" | "recarved" | "none" | "invoiced";

type CarveRef = { overageEventId: string } | { sidePaymentId: string };

async function loadCarveContext(
  tx: Pick<Tx, "overageEvent" | "payment">,
  ref: CarveRef,
) {
  const event = await tx.overageEvent.findFirst({
    where:
      "overageEventId" in ref
        ? { id: ref.overageEventId }
        : { paymentId: ref.sidePaymentId },
    select: {
      id: true,
      basePaise: true,
      overageBehavior: true,
      payment: { select: { id: true, parentPaymentId: true } },
    },
  });
  if (
    !event ||
    event.overageBehavior !== "CHARGE_MEMBER" ||
    event.basePaise <= 0 ||
    !event.payment?.parentPaymentId
  ) {
    return null;
  }
  const parent = await tx.payment.findUnique({
    where: { id: event.payment.parentPaymentId },
    select: { id: true, billableToOrgInvoiceId: true },
  });
  if (!parent) return null;
  return { event, parent };
}

/**
 * FAILED edge: return the carved basePaise to the parent's INVOICE_ACCRUAL
 * leg + amount. Call ONLY after a successful PENDING→FAILED CAS, in the same tx.
 */
export async function restoreOverageBaseCarve(
  tx: Pick<Tx, "overageEvent" | "payment" | "paymentLeg">,
  ref: CarveRef,
): Promise<CarveOutcome> {
  const ctx = await loadCarveContext(tx, ref);
  if (!ctx) return "none";

  // Guarded parent-first write: the invoiced check rides the UPDATE's WHERE
  // (re-evaluated under the row lock), so a rollup stamping
  // billableToOrgInvoiceId between our read and this write yields count 0
  // instead of silently diverging the leg from the issued document.
  const parentBumped = await tx.payment.updateMany({
    where: { id: ctx.parent.id, billableToOrgInvoiceId: null },
    data: { amount: { increment: ctx.event.basePaise } },
  });
  if (parentBumped.count === 0) return "invoiced";

  await tx.paymentLeg.update({
    where: {
      paymentId_source: { paymentId: ctx.parent.id, source: "INVOICE_ACCRUAL" },
    },
    data: { amountPaise: { increment: ctx.event.basePaise } },
  });
  return "restored";
}

/**
 * Recovery edges (FAILED→PENDING retry, FAILED→CHARGED late capture): carve
 * basePaise back out. Call ONLY after a successful CAS from FAILED, in the
 * same tx. "invoiced" = the parent rolled onto an invoice while FAILED
 * (restored base was billed) — the caller must refuse the retry / flag the
 * capture, because the member paying now would double-collect basePaise.
 */
export async function recarveOverageBase(
  tx: Pick<Tx, "overageEvent" | "payment" | "paymentLeg">,
  ref: CarveRef,
): Promise<CarveOutcome> {
  const ctx = await loadCarveContext(tx, ref);
  if (!ctx) return "none";

  // Guarded parent-first write — same TOCTOU shape as the restore above.
  const parentCut = await tx.payment.updateMany({
    where: { id: ctx.parent.id, billableToOrgInvoiceId: null },
    data: { amount: { decrement: ctx.event.basePaise } },
  });
  if (parentCut.count === 0) return "invoiced";

  // Guarded decrement — mirrors the original carve's fail-closed stance.
  // Count 0 here means the leg lacks the restored base while the parent is
  // still uninvoiced: an invariant breach, not a billing race. Throw so the
  // caller's tx rolls the parent decrement back instead of half-applying.
  const carved = await tx.paymentLeg.updateMany({
    where: {
      paymentId: ctx.parent.id,
      source: "INVOICE_ACCRUAL",
      amountPaise: { gte: ctx.event.basePaise },
    },
    data: { amountPaise: { decrement: ctx.event.basePaise } },
  });
  if (carved.count === 0) {
    throw new Error(
      `recarveOverageBase: INVOICE_ACCRUAL leg on payment ${ctx.parent.id} is missing the restored basePaise=${ctx.event.basePaise} — rolling back`,
    );
  }
  return "recarved";
}
