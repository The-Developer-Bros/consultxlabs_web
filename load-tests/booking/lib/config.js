// Environment contract for the #874 load gate. Every knob the harness needs
// arrives as a k6 `--env` variable so the same scripts run locally and from
// the workflow without a checked-in fixture file.
//
// Read the runbook before setting these:
// docs/enterprise/50-operations/08-load-gate-runbook.md

/** Read a required variable, failing loudly in setup() rather than per-VU. */
export function required(name) {
  const value = __ENV[name];
  if (!value) {
    throw new Error(
      `${name} is required — see docs/enterprise/50-operations/08-load-gate-runbook.md`,
    );
  }
  return value;
}

export function optional(name, fallback) {
  const value = __ENV[name];
  return value === undefined || value === "" ? fallback : value;
}

/** Comma-separated list, whitespace-trimmed, empties dropped. */
export function list(name, fallback = []) {
  const raw = optional(name, "");
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function bool(name, fallback) {
  const raw = optional(name, undefined);
  if (raw === undefined) return fallback;
  return raw === "true" || raw === "1";
}

export function int(name, fallback) {
  const parsed = Number.parseInt(optional(name, ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const BASE_URL = optional("BASE_URL", "http://localhost:3000").replace(
  /\/+$/,
  "",
);

// Better Auth rejects a sign-in whose Origin is not in
// BETTER_AUTH_TRUSTED_ORIGINS, and that variable holds the production URL in
// every Netlify context — so a deploy preview's own URL is never trusted and
// a login against it answers 403 INVALID_ORIGIN. AUTH_ORIGIN lets the run send
// the trusted origin while the requests themselves go to BASE_URL. Set it to
// the production URL when BASE_URL is a preview.
export const AUTH_ORIGIN = optional("AUTH_ORIGIN", BASE_URL).replace(
  /\/+$/,
  "",
);

/** Seed accounts that buy. `SeedPass123!` is the seed suite's password. */
export const BUYER_EMAILS = list("BUYER_EMAILS");
export const BUYER_PASSWORD = optional("BUYER_PASSWORD", "SeedPass123!");

/**
 * Pre-minted `better-auth.session_token=...` cookie header values, one per
 * entry, separated by `|`. This is the preferred input: the sign-in limiter is
 * 10 requests per 15 minutes per IP (lib/auth.ts, middleware.ts) and a whole
 * run comes from ONE runner IP, so minting cookies inside setup() caps the
 * usable account pool at eight and cannot be retried after a failed run.
 */
export const BUYER_COOKIES = optional("BUYER_COOKIES", "")
  .split("|")
  .map((entry) => entry.trim())
  .filter(Boolean);

/** Org admins that drive scenario 14c's allocation races. Same two shapes. */
export const ORG_ADMIN_EMAILS = list("ORG_ADMIN_EMAILS");
export const ORG_ADMIN_COOKIES = optional("ORG_ADMIN_COOKIES", "")
  .split("|")
  .map((entry) => entry.trim())
  .filter(Boolean);

/**
 * The consultants that own the reschedule fixtures. Cookie-only on purpose: the
 * sign-in limiter's ten-per-fifteen-minutes budget is already spent on the
 * buyer and org-admin pools, so a third fallback pool could not be minted in
 * the same run. Without these the respond leg is skipped rather than sent to a
 * credential the route will refuse.
 */
export const CONSULTANT_COOKIES = optional("CONSULTANT_COOKIES", "")
  .split("|")
  .map((entry) => entry.trim())
  .filter(Boolean);

/** consultantProfile ids the browse + checkout mix spreads across. */
export const CONSULTANT_IDS = list("CONSULTANT_IDS");

/**
 * ConsultationPlan ids, positionally paired with CONSULTANT_IDS. Checkout takes
 * a planId and derives the consultant from it, so index i of one list must
 * belong to index i of the other.
 */
export const PLAN_IDS = list("PLAN_IDS");

/** Webinar or class id for the hot-event storm, plus its plan. */
export const EVENT_ID = optional("EVENT_ID", "");
export const EVENT_PLAN_ID = optional("EVENT_PLAN_ID", "");
export const EVENT_TYPE = optional("EVENT_TYPE", "WEBINAR");

/**
 * The single consultant-minute every scenario-17 buyer fights over. Both are
 * ISO-8601 with an offset (`z.string().datetime()`), and checkout demands the
 * whole window sit inside published availability, so pick a time the target
 * consultant actually publishes.
 */
export const HOT_SLOT_STARTS_AT = optional("HOT_SLOT_STARTS_AT", "");
export const HOT_SLOT_ENDS_AT = optional("HOT_SLOT_ENDS_AT", "");
export const HOT_CONSULTANT_ID = optional("HOT_CONSULTANT_ID", "");
export const HOT_PLAN_ID = optional("HOT_PLAN_ID", "");

/**
 * Exactly one of these must be set on a consultation checkout: the id proves
 * the named availability row belongs to a live consultant. Since #1320 it is no
 * longer the window boundary, but it is still validated.
 */
export const SLOT_AVAILABILITY_WEEKLY_ID = optional(
  "SLOT_AVAILABILITY_WEEKLY_ID",
  "",
);
export const SLOT_AVAILABILITY_CUSTOM_ID = optional(
  "SLOT_AVAILABILITY_CUSTOM_ID",
  "",
);

/** Consultation/webinar/class/subscription ids for the allocate storm (14c). */
export const ALLOCATE_EVENT_IDS = list("ALLOCATE_EVENT_IDS");
export const ALLOCATE_EVENT_KIND = optional(
  "ALLOCATE_EVENT_KIND",
  "consultations",
);

/** Appointment ids the cancel and reschedule mixes act on. */
export const CANCEL_APPOINTMENT_IDS = list("CANCEL_APPOINTMENT_IDS");
export const RESCHEDULE_APPOINTMENT_IDS = list("RESCHEDULE_APPOINTMENT_IDS");
export const RESCHEDULE_APPOINTMENT_TYPE = optional(
  "RESCHEDULE_APPOINTMENT_TYPE",
  "CONSULTATION",
);

/**
 * Honoured by the route only when the target runs with NODE_ENV=development
 * (app/api/checkout/route.ts). A Netlify deploy preview is a production build,
 * so on a preview this flag is silently ignored and checkout mints a real
 * gateway order against whichever Razorpay keys the target holds. The runbook
 * states the consequence; the flag is sent regardless so a development-mode
 * target short-circuits the gateway.
 */
export const MOCK_PAYMENT = bool("MOCK_PAYMENT", true);

/** Shape of the ramp. PEAK_VUS is the *expected* peak; chaos 6 doubles it. */
export const PEAK_VUS = int("PEAK_VUS", 25);
export const DURATION = optional("DURATION", "3m");
export const SCENARIO = optional("SCENARIO", "all");

/** Concurrency for the point-in-time storms. */
export const HOT_SLOT_BUYERS = int("HOT_SLOT_BUYERS", 50);
export const HOT_EVENT_BUYERS = int("HOT_EVENT_BUYERS", 200);
export const ORG_ADMIN_RACERS = int("ORG_ADMIN_RACERS", 10);

/**
 * A privileged session — the consultant who owns the fixtures, or an ADMIN /
 * STAFF account. `verify-integrity.js` and `cleanup.js` need it because the two
 * routes that can answer "is this consultant-minute double-booked" are both
 * self-scoped: `GET /api/slots/appointments` answers 403 unless the caller
 * filters by their own profile, and `GET /api/participants/webinar/[id]` is
 * owner/collaborator/privileged only.
 */
export const VERIFY_COOKIE = optional("VERIFY_COOKIE", "");

/** consultantProfile ids the integrity check sweeps for double-booked minutes. */
export const CONSULTANT_PROFILE_IDS = list("CONSULTANT_PROFILE_IDS");

/**
 * The event's effective seat count — `Webinar.maxParticipants` when the
 * instance overrides, otherwise the plan's. There is no capacity endpoint (see
 * the runbook's "what the API cannot tell you" section), so the ceiling is
 * supplied rather than discovered, and `verify-integrity.js` re-derives the
 * registered count by de-duplicating participant ids.
 */
export const EVENT_CAPACITY = int("EVENT_CAPACITY", 20);

/**
 * Every consultation this run books lands inside one marked window, so cleanup
 * can find its own rows without a database query: an appointment whose slots
 * start inside the window belongs to the run. Defaults to 04:00 UTC tomorrow
 * (09:30 IST), which is inside a typical seeded workday.
 */
export const WINDOW_START = optional("WINDOW_START", "");
export const WINDOW_ATOMS = int("WINDOW_ATOMS", 48);

/**
 * Requests per minute for the browse reads. The availability limiter is 30 per
 * minute PER IP and does not skip localhost, and a k6 run is one IP, so a
 * browse mix that ramps with the VUs measures the limiter instead of the app.
 * The reads therefore run on their own arrival-rate executor, capped below the
 * limiter by default. Raising this is only meaningful if the limiter is raised
 * with it or the run is distributed across several egress addresses.
 */
export const BROWSE_RPM = int("BROWSE_RPM", 25);
export const SEARCH_RPM = int("SEARCH_RPM", 50);

/**
 * User ids to discount from an event's registered count. The participants route
 * de-duplicates by user id but does NOT exclude the host, while the server's own
 * capacity arithmetic does, so the host would otherwise read as one seat of
 * over-booking. Put the consultant's user id here.
 */
export const EVENT_EXCLUDE_USER_IDS = list("EVENT_EXCLUDE_USER_IDS");

/**
 * consulteeProfile ids paired positionally with the buyer credentials. Only
 * needed for cleanup's optional third pass, which cancels PENDING gateway
 * payments through `DELETE /api/checkout/pending/[paymentId]`. That pass is
 * relevant only to a run against a production build, where `isMockPayment` is
 * ignored and checkout leaves a real pending hold; a mock purchase commits as
 * SUCCEEDED and that route answers 409 for it forever. Leaving it unset is
 * safe — the abandoned-payment sweep expires those holds after thirty minutes.
 */
export const CONSULTEE_PROFILE_IDS = list("CONSULTEE_PROFILE_IDS");

/** Ceiling on cancels per credential, so cleanup cannot run forever. */
export const CLEANUP_MAX_PER_USER = int("CLEANUP_MAX_PER_USER", 40);

/** Where the run writes its machine-readable summary. */
export const SUMMARY_PATH = optional("SUMMARY_PATH", "load-gate-summary.json");
