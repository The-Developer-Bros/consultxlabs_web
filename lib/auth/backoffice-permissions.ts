import type { UserRole } from "@prisma/client";

/**
 * Back-office permission matrix — the single source of truth for which
 * UserRole can access which internal surface. The sidebar (visibility), the
 * page guards, and the API routes all consume THIS map, so a surface can no
 * longer drift into "tab shown, page redirects, API 403s" states. Same
 * contract as `lib/auth/org-permissions.ts`; see that file for the reasoning
 * behind a matrix over a rank ladder.
 *
 * Why this exists at all: admin and staff were two ~85%-identical dashboards
 * whose access difference was expressed only by which route tree you landed
 * in. Merging them into `/dashboard/admin` means the difference has to live
 * somewhere real — here.
 *
 * Policy, stated once:
 *   - STAFF own support end-to-end: tickets, feedback, moderation,
 *     appointments, and user verification. This is the job.
 *   - STAFF READ every money surface, because a support agent who can't see
 *     a payment can't resolve a billing ticket. They mutate none of it.
 *   - STAFF READ recording metadata and ADMIN alone can play a recording
 *     (#1270). The asymmetry is deliberate: the session content is the
 *     customer's, not the operator's, and nothing a support agent does with a
 *     replay ticket requires watching the session.
 *   - ADMIN alone executes money (refunds, payouts, subscription changes),
 *     owns org lifecycle and platform config, and takes the destructive user
 *     actions (ban, role change). Staff are interns and employees with
 *     turnover; irreversible actions concentrate on the account that answers
 *     for them.
 *
 * Deliberately NOT a maker-checker split: there is exactly one admin today,
 * so an approval queue would have a single clearer and would add latency
 * without adding separation of duties. Revisit when a second admin exists —
 * the surface keys below already name the mutations that would need it.
 */

export type BackofficeSurface =
  // Support — the staff remit, full read+write.
  | "tickets.manage"
  | "threads.manage"
  | "feedback.manage"
  | "moderation.manage"
  // Operations — booking-side triage and user verification.
  | "appointments.manage"
  | "waitlist.manage"
  | "leads.manage"
  | "users.read"
  | "users.verify"
  | "users.moderate"
  // Session recordings — #1270. Split because "look at the metadata" and
  // "watch the session" are different acts with different blast radii.
  | "recordings.read"
  | "recordings.play"
  // Money — staff read, admin executes. The `.read` grants are what make
  // billing tickets resolvable without an escalation.
  | "payments.read"
  | "payments.manage"
  | "refunds.read"
  | "refunds.manage"
  | "disputes.read"
  | "disputes.manage"
  | "invoices.read"
  | "invoices.manage"
  | "subscriptions.read"
  | "subscriptions.manage"
  | "payouts.read"
  | "payouts.manage"
  | "approvalPayments.manage"
  | "tds.read"
  // Platform — org lifecycle, comms, and system control.
  | "organizations.manage"
  | "announcements.manage"
  | "analytics.read"
  | "systemJobs.manage"
  | "maintenance.manage";

const roles = (...list: UserRole[]): ReadonlySet<UserRole> =>
  new Set<UserRole>(list);

// Named tiers so the matrix reads as policy, not repetition.
const OPERATORS = roles("ADMIN", "STAFF");
const ADMIN_ONLY = roles("ADMIN");

export const BACKOFFICE_PERMISSIONS: Record<
  BackofficeSurface,
  ReadonlySet<UserRole>
> = {
  // Support — staff's core job, no admin carve-outs.
  "tickets.manage": OPERATORS,
  // #support-hub — the per-appointment conversation inbox; same remit as the
  // ticket queue it escalates into.
  "threads.manage": OPERATORS,
  "feedback.manage": OPERATORS,
  "moderation.manage": OPERATORS,

  // Operations — staff triage bookings and clear the verification queue.
  // `users.moderate` (ban / role change / delete) is the one exception:
  // irreversible and account-destroying, so admin-only.
  "appointments.manage": OPERATORS,
  "waitlist.manage": OPERATORS,
  // #1230 wave-4c — enterprise sales pipeline triage.
  "leads.manage": OPERATORS,
  "users.read": OPERATORS,
  "users.verify": OPERATORS,
  "users.moderate": ADMIN_ONLY,

  // #1270 — a recording is the single most sensitive artefact the platform
  // holds: the full audio and video of a private 1:1 between a consultee and
  // a consultant, neither of whom consented to an operator watching it.
  // Staff resolve "my replay is missing" tickets, and every fact they need for
  // that (status, storage location, duration, expiry) is metadata — none of it
  // requires playback. So staff read the record and admin alone can watch it.
  // Both grants are audited at the route; see lib/stream/recording-operator-access.ts.
  "recordings.read": OPERATORS,
  "recordings.play": ADMIN_ONLY,

  // Money — read for context, mutate only as admin. Payouts, approval
  // payments and TDS have no staff-facing read either: they are settlement
  // and statutory surfaces with no support use case.
  "payments.read": OPERATORS,
  "payments.manage": ADMIN_ONLY,
  "refunds.read": OPERATORS,
  "refunds.manage": ADMIN_ONLY,
  "disputes.read": OPERATORS,
  "disputes.manage": ADMIN_ONLY,
  "invoices.read": OPERATORS,
  "invoices.manage": ADMIN_ONLY,
  "subscriptions.read": OPERATORS,
  "subscriptions.manage": ADMIN_ONLY,
  "payouts.read": ADMIN_ONLY,
  "payouts.manage": ADMIN_ONLY,
  "approvalPayments.manage": ADMIN_ONLY,
  "tds.read": ADMIN_ONLY,

  // Platform — org lifecycle and system control are admin's remit.
  // Announcements are platform-wide outbound comms, so admin-only too.
  // Analytics stays open to staff; the page itself serves an ops slice.
  "organizations.manage": ADMIN_ONLY,
  "announcements.manage": ADMIN_ONLY,
  "analytics.read": OPERATORS,
  "systemJobs.manage": ADMIN_ONLY,
  "maintenance.manage": ADMIN_ONLY,
};

export function hasBackofficePermission(
  role: UserRole,
  surface: BackofficeSurface,
): boolean {
  return BACKOFFICE_PERMISSIONS[surface].has(role);
}
