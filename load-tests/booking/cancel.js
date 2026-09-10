// Write path 4 of 5 — `POST /api/appointments/[id]/cancel`.
//
// The body is optional and validated by `CancelAppointmentSchema`: a
// `CancellationReason` enum member and free-text notes, nothing else. An empty
// body is legal, but the reason is sent so the rows this run creates are
// identifiable afterwards.
//
// This is the most expensive write in the mix. A cancel can compute a refund
// against the policy snapshot, reverse an org-funded intent in-ledger, and — on
// a whole-event cancel — refund every participant. It also takes the
// appointment lock, so it is the path where a lock TTL longer than the function
// ceiling shows up as a 504 rather than a 409 (#1328, and the DEFAULT retry
// budget finding on #1319).
//
// CANCEL_APPOINTMENT_IDS must be appointments the credential pool owns and that
// are still in a cancellable state. A run consumes them: an appointment can be
// cancelled once, so the list is rotated and repeats are expected.
//
// What a repeat still measures, and what it does not, decides how to read the
// numbers. It measures everything up to and including the guard: the limiter,
// the heavy appointment read, the dispute guard, the appointment lock, and the
// CAS that refuses a second cancel. It does NOT measure the work behind the
// guard — the refund quote, the ledger reversal and the whole-event refund
// fan-out all sit past the CAS. So `path_cancel_duration` is a floor once the
// list has wrapped, and the timeout and lock assertions stay honest while the
// latency budget reads optimistically.
//
// One target per invocation would make every request measure the full path, but
// a six-minute mutation ramp issues well over a thousand of them, and each one
// needs a pre-created, still-cancellable appointment on a real calendar in the
// shared production database. Sizing the list to the ramp is the fixture cost
// that buys the stronger measurement; size it as far as the fixtures allow.
//
// Standalone:
//   k6 run --env BASE_URL=... --env CANCEL_APPOINTMENT_IDS=a,b,c \
//          load-tests/booking/cancel.js

import { check, sleep } from "k6";
import { CANCEL_APPOINTMENT_IDS, DURATION, PEAK_VUS } from "./lib/config.js";
import { json, post, rotate } from "./lib/http.js";
import { cancelDuration, isAcceptableLoss, record } from "./lib/metrics.js";
import { establishSessions, pick } from "./lib/session.js";
import { summaryOutputs } from "./lib/report.js";
import { ALL_THRESHOLDS } from "./lib/thresholds.js";

export const options = {
  stages: [
    { duration: "30s", target: Math.max(1, Math.round(PEAK_VUS / 4)) },
    { duration: DURATION, target: Math.max(1, Math.round(PEAK_VUS / 4)) },
    { duration: "30s", target: 0 },
  ],
  thresholds: ALL_THRESHOLDS,
};

export function setup() {
  if (CANCEL_APPOINTMENT_IDS.length === 0) {
    throw new Error("CANCEL_APPOINTMENT_IDS is required for the cancel path");
  }
  return establishSessions();
}

export function runCancel(data, appointmentId, tags) {
  const cookie = pick(data.buyers, __VU + __ITER);
  const target =
    appointmentId || rotate(CANCEL_APPOINTMENT_IDS, __VU * 17 + __ITER);
  const res = post(
    `/api/appointments/${target}/cancel`,
    { reason: "NO_LONGER_NEEDED", notes: "load gate #874" },
    { cookie, tag: "cancel" },
  );
  cancelDuration.add(res.timings.duration, { path: "cancel" });
  const verdict = record(res, tags);
  check(res, {
    "cancel resolved without a platform timeout": () => verdict !== "timeout",
    "cancel succeeded or refused cleanly": () =>
      verdict === "win" || isAcceptableLoss(verdict),
  });
  return { verdict, res, body: json(res), appointmentId: target };
}

export default function (data) {
  runCancel(data);
  sleep(2);
}

export function handleSummary(data) {
  return summaryOutputs(data);
}
