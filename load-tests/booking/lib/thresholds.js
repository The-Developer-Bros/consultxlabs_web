// The pass/fail contract, encoded so the run's exit code is the verdict.
//
// The numbers come from three places and each is annotated with which:
//
//   ceiling   — a platform limit. Netlify functions are killed at roughly 26
//               seconds, so anything at or past it is a 504 to the buyer.
//   published — a criterion already written down in the chaos runbook
//               (docs/enterprise/50-operations/07-chaos-test-runbook.md):
//               scenario 6 wants an error rate under 5% and P95 under two
//               seconds; scenario 17 wants zero raw 502/504 and P95 under 26s.
//   budget    — a target this harness sets for the first run. These are the
//               numbers to revisit once #874 has an actual measurement; they
//               are deliberately generous, because a gate that fails on its
//               first run teaches nothing about the system.

/** Netlify kills a function at roughly this point. Nothing may approach it. */
export const FUNCTION_CEILING_MS = 26000;

export const INTEGRITY_THRESHOLDS = {
  // published (17): a losing racer is entitled to a structured refusal, never
  // a platform timeout. This is the single most important line in the file.
  booking_gateway_timeouts_504: ["count==0"],
  booking_timeout_rate: ["rate==0"],

  // published (17): "zero raw 502/504 responses (structured 4xx only)".
  booking_server_errors_5xx: ["count==0"],

  // published (6): "an error rate under 5%".
  booking_server_error_rate: ["rate<0.05"],

  // budget: a fail-closed lock 503 means Redis was unreachable. It is a correct
  // answer and a failed gate all the same, because the run measured Upstash
  // rather than the booking path.
  booking_lock_unavailable_503: ["count==0"],
};

export const LATENCY_THRESHOLDS = {
  // published (6): the browse hot path.
  path_read_duration: ["p(95)<2000"],

  // budget + ceiling. Checkout is the expensive one — a Serializable
  // transaction inside a Redis lock with a bounded retry — and the capacity
  // ladder already assumes one to two seconds at P95. Eight seconds is the
  // budget under 2x peak; the ceiling assertion is the one that must never
  // move.
  path_checkout_duration: [
    "p(95)<8000",
    `p(95)<${FUNCTION_CEILING_MS}`,
    `max<${FUNCTION_CEILING_MS}`,
  ],

  // budget: auto allocation searches an availability window and writes a batch,
  // so it is allowed more than checkout.
  path_allocate_duration: ["p(95)<10000", `p(95)<${FUNCTION_CEILING_MS}`],

  // budget: cancel can trigger a refund and a whole-event reallocation.
  path_cancel_duration: ["p(95)<8000", `p(95)<${FUNCTION_CEILING_MS}`],

  // budget: reschedule and its response leg are single-appointment writes.
  path_reschedule_duration: ["p(95)<6000", `p(95)<${FUNCTION_CEILING_MS}`],
  path_respond_duration: ["p(95)<6000", `p(95)<${FUNCTION_CEILING_MS}`],

  // ceiling, applied to everything including the requests no path tag caught.
  http_req_duration: [`p(99)<${FUNCTION_CEILING_MS}`],

  // A failed k6 `check()` is an integrity assertion that did not hold.
  checks: ["rate>0.99"],
};

/** The full set every script installs. */
export const ALL_THRESHOLDS = Object.assign(
  {},
  INTEGRITY_THRESHOLDS,
  LATENCY_THRESHOLDS,
);

/**
 * Reduce the end-of-test data down to the table #874 wants recorded. Returned
 * from handleSummary so the artifact is the record rather than a screenshot of
 * the terminal.
 */
export function summarize(data) {
  const m = data.metrics || {};
  const trend = (name) => {
    const values = m[name]?.values;
    if (!values) return null;
    return {
      count: values.count,
      p50: values.med,
      p95: values["p(95)"],
      p99: values["p(99)"],
      max: values.max,
    };
  };
  const count = (name) => m[name]?.values?.count ?? 0;
  const rate = (name) => m[name]?.values?.rate ?? 0;

  return {
    scenario: __ENV.SCENARIO || "all",
    baseUrl: __ENV.BASE_URL || "",
    peakVus: Number.parseInt(__ENV.PEAK_VUS || "0", 10),
    duration: __ENV.DURATION || "",
    startedAt: new Date().toISOString(),
    latency: {
      checkout: trend("path_checkout_duration"),
      allocate: trend("path_allocate_duration"),
      cancel: trend("path_cancel_duration"),
      reschedule: trend("path_reschedule_duration"),
      respond: trend("path_respond_duration"),
      read: trend("path_read_duration"),
      overall: trend("http_req_duration"),
    },
    outcomes: {
      winners: count("booking_winners"),
      conflicts409: count("booking_conflicts_409"),
      busy409: count("booking_busy_409"),
      p2034Conflicts: count("booking_p2034_conflicts"),
      soldOut: count("booking_sold_out"),
      rateLimited429: count("booking_rate_limited_429"),
      lockUnavailable503: count("booking_lock_unavailable_503"),
      timeouts504: count("booking_gateway_timeouts_504"),
      serverErrors5xx: count("booking_server_errors_5xx"),
      clientErrors4xx: count("booking_client_errors_4xx"),
      unexpected4xx: count("booking_unexpected_4xx"),
    },
    rates: {
      serverErrorRate: rate("booking_server_error_rate"),
      timeoutRate: rate("booking_timeout_rate"),
      checksPassRate: rate("checks"),
    },
    totalRequests: count("http_reqs"),
    vusMax: m.vus_max?.values?.max ?? 0,
    thresholdsBreached: Object.keys(m).filter((name) =>
      Object.values(m[name]?.thresholds || {}).some((t) => t && t.ok === false),
    ),
  };
}
