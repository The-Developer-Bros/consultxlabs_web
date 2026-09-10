/**
 * The booking statuses that constitute a direct-message relationship.
 *
 * Split out from `dm-eligibility.ts` deliberately: that module imports Prisma,
 * and this constant is needed by callers that must NOT drag a database client
 * into their module graph — most sharply the Jest suites, where importing it
 * transitively evaluated `@/lib/prisma` before the hoisted `jest.mock` factory's
 * `mockPrisma` binding was initialized, failing the whole suite with a temporal
 * dead-zone error rather than a test failure.
 *
 * Keeping it here also makes the layering honest. This file is the POLICY —
 * which bookings count — and it is pure data. `dm-eligibility.ts` is the
 * MECHANISM that answers the question against the database.
 */
import type { AppointmentStatus } from "@prisma/client";

/**
 * "Ever transacted" — a booking that reached any of these once is a permanent
 * link. Deliberately includes COMPLETED: the conversation about a session is
 * often most valuable after it, and a thread that goes read-only the moment the
 * last appointment ends strands both parties mid-exchange.
 *
 * Deliberately EXCLUDES `PENDING`: a request the consultant has not accepted is
 * not yet a relationship, or anyone could open a channel with anyone by
 * requesting a booking they never intend to pay for.
 *
 * **Changing this changes what the reconciler deletes.**
 * `syncUserEventChannels` treats every `dm-`/`dmo-`/`dmh-` channel absent from
 * its expected set as stale and removes the user from it, and that set is built
 * from this constant. Narrow it and you evict people from live threads; widen
 * it without a create path for the new statuses and you leave search results
 * that no channel backs. Every consumer — the gate, both search routes, and
 * `getDmPairsForUser` — reads this and only this.
 */
export const DM_ELIGIBLE_STATUSES: readonly AppointmentStatus[] = [
  "APPROVED",
  "APPROVED_PENDING_PAYMENT",
  "SCHEDULED",
  "COMPLETED",
] as const;

/**
 * Reusable `where` fragment so callers cannot drift from the constant.
 *
 * Built fresh on each call rather than exported as a shared object: Prisma
 * `where` fragments get spread into query objects all over the codebase, and a
 * frozen-looking module-level constant is one careless `filter.in.push()` away
 * from mutating every other caller's query.
 */
export function dmEligibleStatusFilter(): { in: AppointmentStatus[] } {
  return { in: [...DM_ELIGIBLE_STATUSES] };
}

/**
 * The event (webinar/class) states whose shared team channel can still be
 * opened. Lives here rather than in the two routes that need it — the search
 * route decides which rows are OFFERED and the open route decides which are
 * CLICKABLE, and any disagreement between those two is either a dead row or a
 * wider-than-search authorization surface.
 *
 * Deliberately narrower than the DM set: CANCELLED events must not be
 * openable, and DRAFT is author-only.
 */
export const OPENABLE_EVENT_STATUSES = [
  "SCHEDULED",
  "IN_PROGRESS",
  "COMPLETED",
] as const;
