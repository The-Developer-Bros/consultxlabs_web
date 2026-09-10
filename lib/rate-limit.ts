/**
 * Shared rate limiters for API routes.
 *
 * Rate limit profiles:
 * - authLimiter:            10/15min per IP  — POST /api/auth/sign-in, sign-up, forget-password (brute-force)
 * - checkoutLimiter:        5/min per user   — POST /api/checkout (fraud)
 * - discountLimiter:        10/min per user  — POST /api/payments/discounts/validate (brute-force)
 * - waitlistLimiter:        3/hr per IP      — POST /api/waitlist (newsletter signup spam)
 * - referralApplyLimiter:   3/24h per user   — POST /api/referrals/apply (farming)
 * - spamLimiter:            5/hr per user    — support-tickets, feedbacks, reviews, report
 * - cspReportLimiter:       120/min per IP   — POST /api/csp-report (browser-generated)
 * - trialRequestLimiter:    3/24h per user   — POST /api/trials (spam prevention)
 * - requestApprovalLimiter: 10/hr per user   — POST /api/slots/request-for-approval
 * - searchLimiter:          60/min per IP    — GET /api/user/consultants, /api/consultants/search
 * - eligibilityLimiter:     20/min per IP    — GET /api/trials/check-eligibility
 * - availabilityLimiter:    30/min per IP    — GET /api/slots/availability/[consultantId]
 * - currencyLimiter:        30/min per IP    — GET /api/currency (protects the FX provider quota)
 * - documentUploadLimiter:  10/min per user  — POST /api/appointments/[id]/documents (+ /consultant)
 * - streamRecordingSyncLimiter: 3/5min per user — POST /api/stream/recordings/sync (Stream fan-out)
 */

import { Ratelimit } from "@upstash/ratelimit";
import redis from "@/lib/redis-edge";
import { NextResponse } from "next/server";
import { reportSentryError } from "@/lib/observability/report";

type RatelimitRedis = ConstructorParameters<typeof Ratelimit>[0]["redis"];

// These limiters run in edge middleware on every matched request and fail OPEN
// (see applyRateLimit). The Ratelimit default timeout is 5000ms, so a slow or
// unreachable Upstash would stall the request 5s before allowing it through;
// 500ms keeps the fail-open fallback fast.
const LIMITER_TIMEOUT_MS = (() => {
  const v = Number(process.env.LIMITER_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 500;
})();

function makeLimiter(
  requests: number,
  window: `${number} ${"ms" | "s" | "m" | "h" | "d"}`,
  prefix: string,
): Ratelimit {
  return new Ratelimit({
    redis: redis as RatelimitRedis,
    limiter: Ratelimit.slidingWindow(requests, window),
    prefix,
    timeout: LIMITER_TIMEOUT_MS,
  });
}

/** 10 per 15 minutes — auth endpoints (sign-in, sign-up, forget-password) */
export const authLimiter = makeLimiter(10, "15 m", "rl:auth");

/** 5 per minute — POST /api/checkout */
export const checkoutLimiter = makeLimiter(5, "1 m", "rl:checkout");

/**
 * 10 per minute — DELETE /api/checkout/pending/[paymentId] (#849).
 * Own bucket so releasing a hold never consumes checkout quota — a user
 * abandoning one attempt to start another needs both calls in the same minute.
 */
export const cancelPendingLimiter = makeLimiter(10, "1 m", "rl:cancel-pending");

/** 10 per minute — POST /api/payments/discounts/validate */
export const discountLimiter = makeLimiter(10, "1 m", "rl:discount");

// #677/PM-36 — money-operations limiter for admin/backoffice POST surfaces
// (refunds, dispute evidence, invoice generation). These are low-frequency,
// high-consequence endpoints: 10/min per user is far above legitimate ops
// traffic but caps scripted abuse of the most dangerous buttons in the app.
export const moneyOpsLimiter = makeLimiter(10, "1 m", "rl:money-ops");
// #1230 wave-4c — admin pipeline mutations (lead status moves, etc.).
export const adminMutationLimiter = makeLimiter(10, "1 m", "rl:admin-mutation");

/** 3 per hour — POST /api/waitlist newsletter signup (IP-based) */
export const waitlistLimiter = makeLimiter(3, "1 h", "rl:waitlist");

/** 3 per 24 hours — POST /api/referrals/apply */
export const referralApplyLimiter = makeLimiter(3, "24 h", "rl:referral-apply");

/** 5 per hour — support-tickets, feedbacks, reviews, report (scope key by route) */
export const spamLimiter = makeLimiter(5, "1 h", "rl:spam");

/**
 * 120 per minute per IP — POST /api/csp-report.
 *
 * Was on spamLimiter's 5/hr, which is sized for a HUMAN deciding to file a
 * support ticket. A CSP report is emitted by the browser, unprompted, once per
 * violated directive per page load — so one person opening a few dashboard
 * pages exhausted the hour's quota in seconds and every report after that was
 * dropped with a 429. The report-only rollout was therefore blind in exactly
 * the situation it exists to observe: a directive drifting on a real user.
 *
 * Sized for a page that violates a handful of directives on every navigation,
 * with headroom, while still capping a hostile poster. Reports are logged, not
 * stored, so the cost of a generous ceiling is log volume rather than writes.
 */
export const cspReportLimiter = makeLimiter(120, "1 m", "rl:csp-report");

/**
 * #1134 P1-11 — Stream had NO rate limiting on any route or server action.
 *
 * Two shapes, two budgets:
 *
 * `streamJoinLimiter` guards the meeting join gate. It is the enumeration
 * surface: call ids are deterministic (`slot-<anchorSlotId>`), so an attacker
 * who has one slot id can walk neighbours. Generous enough that a flaky network
 * retrying a join never trips it, tight enough that scanning is useless.
 *
 * `streamApiLimiter` guards the search / channel-create / block routes, which
 * are ordinary authenticated reads and writes but were completely unbounded —
 * every one of them costs a Stream API call we are billed for.
 */
export const streamJoinLimiter = makeLimiter(20, "1 m", "rl:stream-join");
export const streamApiLimiter = makeLimiter(60, "1 m", "rl:stream-api");

/**
 * 3 per 5 minutes per user — POST /api/stream/recordings/sync (#1270).
 *
 * The edge `stream: api` rule already covers this path, but at 60/min keyed by
 * IP, which is sized for ordinary reads. This one call walks every session the
 * caller owns or is enrolled in and issues a `listRecordings` request to Stream
 * for each, so a single authenticated user can force an unbounded, billable
 * fan-out — and the middleware bucket is shared with everyone behind the same
 * NAT, so it is the wrong shape to defend it.
 *
 * Sized on what the feature is for: a user clicks "Sync" because a replay is
 * missing, and the answer does not change on the second press. Three attempts
 * in five minutes covers an impatient human and a retry after a transient
 * error; it does not cover a loop.
 */
export const streamRecordingSyncLimiter = makeLimiter(
  3,
  "5 m",
  "rl:stream-recording-sync",
);

/** 3 per 24 hours — POST /api/trials (prevents flooding consultant inboxes) */
export const trialRequestLimiter = makeLimiter(3, "24 h", "rl:trial-request");

/** 10 per hour — POST /api/slots/request-for-approval */
export const requestApprovalLimiter = makeLimiter(
  10,
  "1 h",
  "rl:request-approval",
);

/** 60 per minute — GET /api/user/consultants, GET /api/consultants/search */
export const searchLimiter = makeLimiter(60, "1 m", "rl:search");

/** 20 per minute — GET /api/trials/check-eligibility */
export const eligibilityLimiter = makeLimiter(20, "1 m", "rl:eligibility");

/** 30 per minute — GET /api/slots/availability/[consultantId] (IP-based, public booking flow) */
export const availabilityLimiter = makeLimiter(30, "1 m", "rl:availability");

/**
 * 30 per minute per IP — GET /api/currency (#1396).
 *
 * The route was public and completely unbounded, and every miss on the
 * per-instance rate cache becomes an outbound call to ExchangeRate-API's free
 * tier, whose 429 carries roughly a twenty-minute lockout. One scripted caller
 * could therefore take FX display down for every buyer on the site. IP-keyed
 * because the endpoint is anonymous: a visitor reading prices has no session.
 * Thirty a minute is far above what a browsing session needs — the client
 * caches the answer for an hour — while a loop trips it immediately.
 */
export const currencyLimiter = makeLimiter(30, "1 m", "rl:currency");

/** 30 per minute — GET /api/participants/{class,webinar}/[id] (per user) */
export const participantReadLimiter = makeLimiter(30, "1 m", "rl:participants");

/** 10 per minute — event mutations: /api/bookings/* POST/PATCH + [id]/validate + [id]/allocate (#831) */
export const eventMutationLimiter = makeLimiter(10, "1 m", "rl:event-mutation");

/**
 * 10 per minute per user — DOC-2 (#694): document upload POSTs
 * (appointment documents + consultant response uploads). Each upload
 * touches Supabase Storage and creates a DB row, so an unthrottled loop
 * can both balloon storage cost and flood the reviewer; bursts of a few
 * files at once stay under the limit.
 */
export const documentUploadLimiter = makeLimiter(
  10,
  "1 m",
  "rl:document-upload",
);

/**
 * 30 per minute per user — #347 bulk document review. One request reviews many
 * documents in a single transaction (replacing the old N-PATCH fan-out), so the
 * limit is generous; it only guards against a script hammering the endpoint.
 */
export const documentReviewLimiter = makeLimiter(
  30,
  "1 m",
  "rl:document-review",
);

// ============================================================================
// Enterprise (arch-4) — per-org / per-IP buckets for org-specific surfaces.
//
// These are narrower than the global authLimiter because an org-scoped
// attacker (e.g. credential-stuffing against a single tenant's SSO) can
// keep the global IP counter fresh by rotating source IPs. Adding an
// org-scoped bucket catches single-tenant floods that wouldn't trip the
// global bucket.
// ============================================================================

/** 30 per hour — POST /api/organizations/invitations/accept (IP-based; org-level identity only available post-token-lookup, which middleware can't do) */
export const orgInviteAcceptLimiter = makeLimiter(
  30,
  "1 h",
  "rl:org-invite-accept",
);

/** 60 per hour — GET /api/auth/sso/domain-check (IP-based, prevents org-existence enumeration) */
export const ssoDomainCheckLimiter = makeLimiter(
  60,
  "1 h",
  "rl:sso-domain-check",
);

/** 20 per hour per org — POST /api/organizations/[orgId]/billing-account/wallet/top-ups (orgId-keyed; blocks a single org from minting hundreds of Razorpay orders) */
export const orgWalletTopUpLimiter = makeLimiter(
  20,
  "1 h",
  "rl:org-wallet-topup",
);

/** 20 per hour per org — POST /api/organizations/[orgId]/invitations
 * (orgId-keyed; prevents a malicious OWNER from flooding audit logs and
 *  Novu ORG_INVITE_SENT workflows via rapid-fire invite spam) */
export const orgInviteLimiter = makeLimiter(20, "1 h", "rl:org-invite");

/**
 * 10 per hour per org — POST /api/organizations/[orgId]/programs/[programId]/auto-enroll
 * (#1230 wave-9). One call provisions up to 200 ProgramAssignment rows, each
 * writing an audit row and (for LICENSED_SEAT) bumping activeSeatCount.
 * Org-keyed so a stuck automation loop can't churn seats/audit all day and one
 * tenant's provisioning burst can't crowd out others on the shared bucket.
 */
export const orgAutoEnrollLimiter = makeLimiter(
  10,
  "1 h",
  "rl:org-auto-enroll",
);

/**
 * 5 per minute per org — POST /api/organizations/[orgId]/webhooks
 * + PATCH endpoint + rotate-secret. Org-keyed to keep a misconfigured
 * automation from chewing through the audit log (every CRUD writes a
 * WEBHOOK row). Generous enough for the human admin clicking
 * "rotate secret" twice on a stuck modal but restrictive enough to
 * stop a runaway script. See `lib/enterprise/outbound-webhooks/*`.
 */
export const orgWebhookLimiter = makeLimiter(5, "1 m", "rl:org-webhook");

/**
 * 60 requests per minute per token — SCIM 2.0 bearer endpoint.
 * Matches Okta + Azure AD default polling cadence; integrator IdPs
 * tend to issue 10–30 RPM at most, so 60 is two-headroom while still
 * mitigating runaway loops in test scripts. Keyed on tokenHash so a
 * leaked token can't burn another org's quota.
 */
export const scimLimiter = makeLimiter(60, "1 m", "rl:scim");

/**
 * 1 per 24h per org — POST /api/organizations/[orgId]/data-exports.
 * The bundle build is expensive (cross-entity walk + zip + Supabase
 * Storage upload + Resend email). One export per day is well above
 * the DPDP §11 use-case (responding to a regulator request) and far
 * below the cost ceiling we want to expose to a single tenant.
 */
export const orgDataExportLimiter = makeLimiter(
  1,
  "24 h",
  "rl:org-data-export",
);

/**
 * Apply rate limit to a request.
 * Returns a 429 NextResponse if exceeded, otherwise null.
 *
 * @param limiter    - Named Ratelimit instance from this module
 * @param identifier - Rate limit key: userId for auth'd routes, IP for public routes.
 *                     Prefix with a route slug when reusing the same limiter across
 *                     multiple endpoints (e.g. `tickets:${userId}`).
 */
// Module scope, so the window is per function instance and resets with it.
const REDIS_FAILURE_REPORT_INTERVAL_MS = 60_000;
let lastRedisFailureReportAt = 0;

export async function applyRateLimit(
  limiter: Ratelimit,
  identifier: string,
): Promise<NextResponse | null> {
  try {
    const { success, remaining } = await limiter.limit(identifier);
    if (!success) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        {
          status: 429,
          headers: { "X-RateLimit-Remaining": String(remaining) },
        },
      );
    }
    return null;
  } catch (error) {
    // Fail open is deliberate (#1125) — but a Redis outage silently disables
    // every rate limiter in the app, so it must be reported, not swallowed.
    //
    // `identifier` is deliberately NOT attached. Callers key on whatever
    // identifies the caller, and app/api/consultants/search/route.ts passes a
    // raw client IP — which would put PII in Sentry against this project's
    // sendDefaultPii: false. It buys nothing anyway: when Redis is down every
    // limiter fails, so one sample's key is not diagnostic, and the captured
    // transaction already names the route. (#1127)
    // Throttled to one report per instance per minute. Unthrottled, a Redis
    // outage fires a capture on EVERY limited request across every route — the
    // failure is total, not per-caller, so the second event of an outage carries
    // no information the first did not, and the volume both burns quota and
    // buries unrelated alerts. Per-instance rather than global on purpose: there
    // is no shared state to coordinate through when the shared state IS what is
    // down. (#1125)
    const now = Date.now();
    if (now - lastRedisFailureReportAt > REDIS_FAILURE_REPORT_INTERVAL_MS) {
      lastRedisFailureReportAt = now;
      reportSentryError(error, {
        subsystem: "rate-limit",
        op: "applyRateLimit",
        expected: false,
      });
    }
    return null;
  }
}

/**
 * Extract the client IP from request headers.
 * Use for IP-based rate limiting on public endpoints.
 *
 * Header preference (most-trusted first):
 *   - `req.ip` (Next.js / Vercel-derived)
 *   - `x-nf-client-connection-ip` (Netlify canonical client IP)
 *   - `x-forwarded-for` (first hop)
 *
 * Returns the sentinel `"unknown_ip"` when nothing resolves. The
 * production middleware MUST NOT bypass on this sentinel — see
 * `isBypassableIp`. In dev / test, the sentinel is treated as
 * localhost and waved through.
 */
export function getClientIp(req: {
  ip?: string;
  headers: { get(name: string): string | null };
}): string {
  const ip =
    req.ip ??
    req.headers.get("x-nf-client-connection-ip")?.trim() ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return ip || "unknown_ip";
}

/**
 * Returns true when an IP value is safe to bypass rate-limiting on.
 * Localhost handles (`::1`, `127.0.0.1`) and the `unknown_ip` sentinel
 * are bypassable in non-production environments only — production
 * traffic that arrives without a usable IP header should fall into the
 * normal limiter bucket so a header-stripping attacker pays the same
 * rate-limit price as a real client. Previously the sentinel was an
 * unconditional bypass, which meant a misconfigured reverse-proxy in
 * production would silently disable every limiter.
 */
export function isBypassableIp(ip: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return ip === "::1" || ip === "127.0.0.1" || ip === "unknown_ip";
}
