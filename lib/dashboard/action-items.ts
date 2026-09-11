import type { ActionItem } from "@/lib/enterprise/org-activation";
import {
  CONSULTEE_JOIN_WINDOW_MS,
  getSessionJoinState,
  groupSlotsIntoRuns,
  type SessionSlotLike,
} from "@/lib/appointments/slots";

/**
 * Derives the "needs you now" queue for the personal dashboards.
 *
 * Pure functions over data those pages already fetch — no new endpoints. The
 * org dashboard has had this since #1019 (`deriveActionItems` in
 * lib/enterprise/org-activation.ts); this is the same idea for consultants
 * and consultees, and reuses that module's `ActionItem` shape so one panel
 * component renders all three.
 *
 * The bar for inclusion is deliberately high: an item earns a place here only
 * if the user is the one blocking it and there is a single obvious next
 * click. "You have 12 upcoming sessions" is not an action — it's a summary,
 * and summaries belong further down the page.
 */

/** A session is "imminent" inside this window — close enough to act on. */
const IMMINENT_MS = 60 * 60 * 1000; // 1 hour

function pluralise(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export interface ImminentSession {
  /**
   * The slot row and the booking it belongs to. Both optional because not
   * every surface has rows to give: the consultee home tab already hands us
   * run-level times, while the consultant tab hands us the raw 30-minute
   * rows. When they are present, consecutive rows of one booking collapse
   * into a single session (#1061) instead of each half hour announcing
   * itself as a separate thing starting 30 minutes from now.
   */
  id?: string;
  appointmentId?: string | null;
  startsAt: Date | string;
  endsAt?: Date | string | null;
  title: string;
}

/**
 * Shared by both roles: the session that is running now, or starting within
 * the hour. Only the soonest is surfaced — a list of everything upcoming is
 * the Appointments tab's job, and repeating it here is exactly the
 * duplication this panel replaced.
 */
/**
 * The three distinct things a session flag can mean. Kept as a function rather
 * than a nested ternary inline: the join window opens BEFORE the start and
 * stays open throughout, so "about to begin" and "under way" are different
 * answers that one flag cannot carry (#1061).
 */
function sessionTitle(
  inProgress: boolean,
  isJoinable: boolean,
  mins: number,
): string {
  if (inProgress) return "Session in progress";
  if (isJoinable) return `Starting in ${mins} min`;
  return `Session in ${mins} min`;
}

export function imminentSessionItem(
  sessions: ImminentSession[],
  appointmentsHref: string,
  now: Date = new Date(),
): ActionItem | null {
  // The title rides along on the row so the winning run can name itself.
  const rows: Array<SessionSlotLike & { title: string }> = sessions.map(
    (session, index) => ({
      id: session.id ?? `imminent:${index}`,
      appointmentId: session.appointmentId ?? null,
      startsAt: session.startsAt,
      endsAt: session.endsAt ?? null,
      title: session.title,
    }),
  );

  // Already ordered earliest-first by the grouping helper.
  const runs = groupSlotsIntoRuns(rows);

  for (const run of runs) {
    // The join window is the shared constant, and the window test is the
    // shared helper. #1061 was two surfaces holding private copies of both
    // and drifting apart; a third copy here would be the same mistake.
    const state = getSessionJoinState(run, {
      joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
      now,
    });
    if (state === "ended" || state === "disabled") continue;

    const msUntilStart = run.startsAt.getTime() - now.getTime();
    if (msUntilStart > IMMINENT_MS) break;

    // The same helper with no pre-start allowance: it can only answer
    // "joinable" once `now` is past the start, which is exactly the "already
    // running" question, and it still answers "ended" past the end. Deriving
    // it this way rather than comparing times again keeps one definition of
    // when a session is under way.
    const inProgress =
      getSessionJoinState(run, { joinWindowMs: 0, now }) === "joinable";

    // Rounded for display only — the window itself is decided above, on the
    // exact instant, because a session 10m29s out rounds to 10.
    const mins = Math.max(1, Math.round(msUntilStart / 60_000));

    return {
      key: "session-imminent",
      severity: state === "joinable" ? "critical" : "warning",
      // A session 25 minutes in used to read "starting now" (#1061): the
      // join window opens before the start and stays open throughout, so
      // one flag could not tell "about to begin" from "under way".
      title: sessionTitle(inProgress, state === "joinable", mins),
      body: run.anchor.title,
      // Both labels say "View": `ctaHref` is the appointments list, not the
      // meeting, and ActionRequiredPanel renders it as an ordinary link. Saying
      // "Join" promised a call and delivered a list. The urgency is already
      // carried by `severity` and the title.
      ctaLabel: "View",
      ctaHref: appointmentsHref,
    };
  }

  return null;
}

export interface ConsultantActionInput {
  /** Requests awaiting slot allocation by this consultant. */
  pendingApprovals: number;
  /** Documents uploaded by consultees and awaiting this consultant's review. */
  documentsAwaitingReview?: number;
  upcomingSessions: ImminentSession[];
  basePath: string;
}

export function deriveConsultantActionItems({
  pendingApprovals,
  documentsAwaitingReview = 0,
  upcomingSessions,
  basePath,
}: ConsultantActionInput): ActionItem[] {
  const items: ActionItem[] = [];

  const imminent = imminentSessionItem(
    upcomingSessions,
    `${basePath}/appointments`,
  );
  if (imminent) items.push(imminent);

  if (pendingApprovals > 0) {
    items.push({
      key: "pending-requests",
      severity: "warning",
      title: `${pendingApprovals} ${pluralise(pendingApprovals, "request needs", "requests need")} slot allocation`,
      body: "Learners are waiting on times from you before they can book.",
      ctaLabel: "Allocate",
      ctaHref: `${basePath}/requests`,
    });
  }

  if (documentsAwaitingReview > 0) {
    items.push({
      key: "documents-review",
      severity: "info",
      title: `${documentsAwaitingReview} ${pluralise(documentsAwaitingReview, "document awaits", "documents await")} your review`,
      body: "Uploaded by learners ahead of their sessions.",
      ctaLabel: "Review",
      ctaHref: `${basePath}/documents`,
    });
  }

  return items;
}

export interface ConsulteeActionInput {
  /** Charges the learner still owes — blocks or risks their booking. */
  pendingPaymentCount: number;
  pendingPaymentTotalPaise?: number;
  upcomingSessions: ImminentSession[];
  basePath: string;
}

export function deriveConsulteeActionItems({
  pendingPaymentCount,
  pendingPaymentTotalPaise = 0,
  upcomingSessions,
  basePath,
}: ConsulteeActionInput): ActionItem[] {
  const items: ActionItem[] = [];

  const imminent = imminentSessionItem(
    upcomingSessions,
    `${basePath}/appointments`,
  );
  if (imminent) items.push(imminent);

  if (pendingPaymentCount > 0) {
    const amount =
      pendingPaymentTotalPaise > 0
        ? ` (₹${(pendingPaymentTotalPaise / 100).toLocaleString("en-IN")})`
        : "";
    items.push({
      key: "pending-payments",
      severity: "critical",
      title: `${pendingPaymentCount} ${pluralise(pendingPaymentCount, "payment is", "payments are")} outstanding${amount}`,
      body: "Your booking isn't confirmed until payment clears.",
      ctaLabel: "Pay",
      ctaHref: `${basePath}/payments`,
    });
  }

  return items;
}
