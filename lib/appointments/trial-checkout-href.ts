import type { AppointmentVM } from "@/lib/appointments/view-model";

/** The synthetic row-id prefix the trial mappers mint (map-consultee.ts:246, map-consultant.ts:296). */
const TRIAL_VM_ID_PREFIX = "trial-";

/**
 * The branded checkout href for a trial that is waiting to be paid for, or
 * null for every other booking.
 *
 * A trial has our own checkout page, which names the amount and the hold
 * deadline before handing off to the gateway (#1167). The raw
 * `vm.pendingPaymentUrl` is the gateway short link, so opening it drops the
 * buyer straight into Razorpay with none of that context. Every surface with a
 * "Pay Now" affordance has to ask this question, and #1428 proved it: a second
 * entry point on the detail page shipped without the branch and regressed the
 * trial path back to the raw link (#1429 F2). Keeping it here means a new
 * surface inherits the answer instead of re-deriving it.
 *
 * The TrialSession id only survives inside the synthetic vm id, which is why
 * the prefix is parsed rather than read from a field.
 */
export function trialCheckoutHref(
  vm: Pick<AppointmentVM, "kind" | "id">,
): string | null {
  if (vm.kind !== "TRIAL" || !vm.id.startsWith(TRIAL_VM_ID_PREFIX)) return null;
  return `/checkout/plans/trial/${vm.id.slice(TRIAL_VM_ID_PREFIX.length)}`;
}
