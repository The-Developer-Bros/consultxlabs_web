// Write path 2 of 5 — `POST /api/checkout` for a webinar or class seat.
//
// The event arm of `checkoutSchema` needs only `eventId` alongside the plan;
// there is no slot window, because the event carries its own schedule. This is
// the capacity path: the guards under test are the optimistic pre-check
// (`readEventCapacity`, which must answer SOLD OUT before the mutex is even
// requested), the per-event mutex, and the tentative-inclusive participant
// recount inside the Serializable transaction.
//
// Standalone:
//   k6 run --env BASE_URL=... --env EVENT_ID=... --env EVENT_PLAN_ID=... \
//          load-tests/booking/checkout-event.js

import { check, sleep } from "k6";
import {
  DURATION,
  EVENT_ID,
  EVENT_PLAN_ID,
  EVENT_TYPE,
  MOCK_PAYMENT,
  PEAK_VUS,
} from "./lib/config.js";
import { idempotencyKey, json, post } from "./lib/http.js";
import { checkoutDuration, isAcceptableLoss, record } from "./lib/metrics.js";
import { establishSessions, pick } from "./lib/session.js";
import { summaryOutputs } from "./lib/report.js";
import { ALL_THRESHOLDS } from "./lib/thresholds.js";

export const options = {
  stages: [
    { duration: "30s", target: PEAK_VUS },
    { duration: DURATION, target: PEAK_VUS },
    { duration: "30s", target: 0 },
  ],
  thresholds: ALL_THRESHOLDS,
};

export function setup() {
  if (!EVENT_ID || !EVENT_PLAN_ID) {
    throw new Error("EVENT_ID and EVENT_PLAN_ID are required for this path");
  }
  return establishSessions();
}

export function eventBody(key) {
  return {
    appointmentType: EVENT_TYPE, // WEBINAR or CLASS
    planId: EVENT_PLAN_ID,
    eventId: EVENT_ID,
    clientIdempotencyKey: key,
    paymentGateway: "RAZORPAY",
    isMockPayment: MOCK_PAYMENT,
  };
}

export function runCheckoutEvent(data, tags) {
  const cookie = pick(data.buyers, __VU + __ITER);
  const key = idempotencyKey("cev");
  const res = post("/api/checkout", eventBody(key), {
    cookie,
    tag: "checkout_event",
    key,
  });
  checkoutDuration.add(res.timings.duration, { path: "checkout_event" });
  const verdict = record(res, tags);
  check(res, {
    "event checkout resolved without a platform timeout": () =>
      verdict !== "timeout",
    "event checkout won or was refused with an honest reason": () =>
      verdict === "win" || isAcceptableLoss(verdict),
  });
  return { verdict, res, body: json(res) };
}

export default function (data) {
  runCheckoutEvent(data);
  sleep(1);
}

export function handleSummary(data) {
  return summaryOutputs(data);
}
