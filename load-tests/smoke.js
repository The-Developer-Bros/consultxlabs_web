// k6 smoke test — verifies the hottest read endpoints hold up under moderate
// concurrency and exposes Supabase connection-pool pressure before real users
// do (capacity ladder: docs/enterprise/50-operations/08-capacity-ladder.md,
// ADR 14). Correctness-under-race is NOT this script's job — that lives in
// tests/typescript/race-conditions (npm run test:chaos:api).
//
// Run (local):   k6 run --env BASE_URL=http://localhost:3000 \
//                       --env TEST_EMAIL=<seed-email> \
//                       --env TEST_PASSWORD=<seed-password> \
//                       --env CONSULTANT_ID=<consultantProfile id> \
//                       load-tests/smoke.js
// Run (staging): point BASE_URL at the staging clone; never at production.

import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend } from "k6/metrics";

const errorRate = new Rate("errors");
const slotAvailabilityTrend = new Trend("slot_availability_duration");

export const options = {
  stages: [
    { duration: "30s", target: 20 }, // warm-up ramp
    { duration: "60s", target: 50 }, // sustained load
    { duration: "30s", target: 100 }, // spike
    { duration: "30s", target: 0 }, // ramp down
  ],
  thresholds: {
    http_req_duration: ["p(95)<3000"],
    errors: ["rate<0.05"],
    // availability is the public booking hot path (rate-limited 30/min/IP —
    // expect 429s to register as errors if a single-IP run exceeds that)
    slot_availability_duration: ["p(95)<1500"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const TEST_EMAIL = __ENV.TEST_EMAIL || "";
const TEST_PASSWORD = __ENV.TEST_PASSWORD || "";
const CONSULTANT_ID = __ENV.CONSULTANT_ID || "";

export function setup() {
  if (!TEST_EMAIL || !TEST_PASSWORD || !CONSULTANT_ID) {
    throw new Error(
      "Set TEST_EMAIL, TEST_PASSWORD and CONSULTANT_ID env vars (seed data).",
    );
  }
  const loginRes = http.post(
    `${BASE_URL}/api/auth/sign-in/email`,
    JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    {
      headers: { "Content-Type": "application/json", Origin: BASE_URL },
    },
  );
  check(loginRes, { "login succeeded": (r) => r.status === 200 });
  const sessionCookie =
    loginRes.cookies["better-auth.session_token"]?.[0]?.value;
  if (!sessionCookie) {
    throw new Error("Login failed — no session cookie. Check credentials.");
  }
  return { sessionCookie };
}

export default function (data) {
  const headers = {
    "Content-Type": "application/json",
    Cookie: `better-auth.session_token=${data.sessionCookie}`,
  };

  // 1. Health (cheap, surfaces database reachability + maintenance phase)
  group("health", function () {
    const res = http.get(`${BASE_URL}/api/health`);
    const ok = check(res, {
      "health 200": (r) => r.status === 200,
      "database connected": (r) => {
        try {
          return JSON.parse(r.body).database === "connected";
        } catch {
          return false;
        }
      },
    });
    errorRate.add(!ok);
  });

  sleep(0.5);

  // 2. Slot availability (public booking hot path)
  group("slot_availability", function () {
    const res = http.get(
      `${BASE_URL}/api/slots/availability/${CONSULTANT_ID}`,
      { headers },
    );
    slotAvailabilityTrend.add(res.timings.duration);
    const ok = check(res, {
      "availability 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);
  });

  sleep(0.5);

  // 3. Consultant search (browse hot path)
  group("consultant_search", function () {
    const res = http.get(`${BASE_URL}/api/user/consultants?limit=20&page=1`, {
      headers,
    });
    const ok = check(res, { "search 200": (r) => r.status === 200 });
    errorRate.add(!ok);
  });

  sleep(1);
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify(
      {
        vus_max: data.metrics.vus_max?.values?.max,
        http_req_duration_p95:
          data.metrics.http_req_duration?.values?.["p(95)"],
        error_rate: data.metrics.errors?.values?.rate,
        total_requests: data.metrics.http_reqs?.values?.count,
        slot_availability_p95:
          data.metrics.slot_availability_duration?.values?.["p(95)"],
      },
      null,
      2,
    ),
  };
}
