/**
 * Canonical outbound webhook event catalog.
 *
 * Why these eight events
 * ----------------------
 * The catalog is intentionally small. Each event name corresponds to a
 * concrete state-change in the org's business surface that an external
 * integrator (HRIS, finance ERP, customer-success tool) will want to react
 * to. Adding more events is a one-line addition here + the matching
 * `dispatchWebhookEvent` call at the emit-point — but the API contract
 * with subscribers locks once published, so resist the urge to enumerate
 * every internal mutation.
 *
 * Naming convention
 * -----------------
 * `<entity>.<verb_past_tense>` — matches the Stripe / GitHub Actions /
 * Linear convention. Dots are SCIM-style separators, not slashes, so
 * `event.startsWith("invoice.")` is the natural filter shape in
 * integrator code.
 *
 * Versioning
 * ----------
 * The payload shape is versioned implicitly by the event name. If we
 * ever need to evolve `invoice.issued`'s shape in a way that breaks
 * existing receivers, we add `invoice.issued.v2` rather than mutate the
 * existing event — closed-set, append-only.
 */

export const OUTBOUND_WEBHOOK_EVENTS = [
  /// Membership lifecycle. Emitted from `membership-transitions.ts`
  /// (in-app invite accept + manual role change) AND from the SCIM
  /// resource handlers (IdP-driven provisioning).
  "member.added",
  "member.removed",

  /// Invoice lifecycle. `invoice.issued` fires on transition to ISSUED
  /// (status change OR initial POST with issueImmediately=true).
  /// `invoice.paid` fires when the payment route confirms settlement
  /// (Razorpay webhook → wallet ledger entry → status flip to PAID).
  "invoice.issued",
  "invoice.paid",

  /// Payout lifecycle. `payout.completed` is the green-path
  /// confirmation that the bank transfer actually settled (RazorpayX
  /// `payout.processed` webhook); `payout.failed` covers both
  /// gateway-time rejection AND post-completion reversal so integrators
  /// don't have to subscribe to two events to handle the unhappy path.
  "payout.completed",
  "payout.failed",

  /// Contract + program assignment. `contract.signed` fires on the
  /// status transition to ACTIVE; `program.assigned` fires from
  /// `ProgramAssignment.create` (or the idempotent upsert path).
  "contract.signed",
  "program.assigned",
] as const;

export type OutboundWebhookEvent = (typeof OUTBOUND_WEBHOOK_EVENTS)[number];

/**
 * Runtime narrowing guard — useful when validating subscription lists
 * coming in from the API (the route accepts `string[]` and needs to
 * reject anything outside the catalog).
 */
export function isOutboundWebhookEvent(
  value: unknown,
): value is OutboundWebhookEvent {
  return (
    typeof value === "string" &&
    (OUTBOUND_WEBHOOK_EVENTS as readonly string[]).includes(value)
  );
}
