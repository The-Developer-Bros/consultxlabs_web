// Write path 5 of 5 — reschedule, and the counterparty's answer.
//
//   POST /api/appointments/[id]/reschedule?type=CONSULTATION
//   POST /api/appointments/[id]/reschedule/respond
//
// The reschedule body is `RescheduleProposalSchema`, which is `.passthrough()`
// and entirely optional: `{}` means "release these times, anything works", and
// that is the only shape a group event accepts. When concrete times ARE
// proposed, each row must be EXACTLY one 30-minute atom — a 60-minute row is
// silently booked as 30 by the auto-confirm path, which is why the schema
// rejects it rather than trusting the caller.
//
// The `type` query parameter names the appointment type; the route re-derives
// it from the database rather than trusting the parameter, so a wrong value is
// a 4xx and never a mis-write.
//
// The respond body is `{ action: "accept" | "decline" }`. Accept re-validates
// the proposed times through the full allocator, so it is the expensive leg and
// gets its own latency trend.
//
// The respond route answers the COUNTERPARTY only, and it answers 404 to
// everyone else — including the initiator — so that it cannot be walked to
// discover which bookings hold live reschedules. `runReschedule()` opens the
// proposal as a buyer, which makes the consultant the counterparty, so the
// respond leg needs its own credential (CONSULTANT_COOKIES). Without one it is
// skipped: a buyer answering their own proposal measures the 404 branch, not
// the allocator.
//
// Reschedule is re-entrant by design: multiple concurrent winners on one
// appointment are LEGAL (chaos scenario 10). The assertion here is therefore
// not "exactly one winner" but "no server errors and no timeouts".
//
// Standalone:
//   k6 run --env BASE_URL=... --env RESCHEDULE_APPOINTMENT_IDS=a,b \
//          load-tests/booking/reschedule.js

import { check, sleep } from "k6";
import {
  DURATION,
  PEAK_VUS,
  RESCHEDULE_APPOINTMENT_IDS,
  RESCHEDULE_APPOINTMENT_TYPE,
} from "./lib/config.js";
import { json, post, rotate } from "./lib/http.js";
import {
  isAcceptableLoss,
  record,
  respondDuration,
  rescheduleDuration,
} from "./lib/metrics.js";
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
  if (RESCHEDULE_APPOINTMENT_IDS.length === 0) {
    throw new Error(
      "RESCHEDULE_APPOINTMENT_IDS is required for the reschedule path",
    );
  }
  const sessions = establishSessions();
  if (sessions.consultants.length === 0) {
    console.warn(
      "no CONSULTANT_COOKIES — the respond leg will be skipped and path_respond_duration will be empty",
    );
  }
  return sessions;
}

export function runReschedule(data, appointmentId, tags) {
  const cookie = pick(data.buyers, __VU + __ITER);
  const target =
    appointmentId || rotate(RESCHEDULE_APPOINTMENT_IDS, __VU * 13 + __ITER);
  const res = post(
    `/api/appointments/${target}/reschedule?type=${RESCHEDULE_APPOINTMENT_TYPE}`,
    // No proposedSlots: "release the times, any replacement works" is the
    // shape that needs no calendar knowledge and is valid for every type.
    { reason: "load gate #874" },
    { cookie, tag: "reschedule" },
  );
  rescheduleDuration.add(res.timings.duration, { path: "reschedule" });
  const verdict = record(res, tags);
  check(res, {
    "reschedule resolved without a platform timeout": () =>
      verdict !== "timeout",
    "reschedule succeeded or refused cleanly": () =>
      verdict === "win" || isAcceptableLoss(verdict),
  });
  return { verdict, res, body: json(res), appointmentId: target };
}

export function runRespond(data, appointmentId, action, tags) {
  const consultants = data.consultants || [];
  if (consultants.length === 0) return null;
  const cookie = pick(consultants, __VU + __ITER);
  const target =
    appointmentId || rotate(RESCHEDULE_APPOINTMENT_IDS, __VU * 13 + __ITER);
  const res = post(
    `/api/appointments/${target}/reschedule/respond`,
    { action: action || "decline" },
    { cookie, tag: "reschedule_respond" },
  );
  respondDuration.add(res.timings.duration, { path: "reschedule_respond" });
  const verdict = record(res, tags);
  check(res, {
    "respond resolved without a platform timeout": () => verdict !== "timeout",
    "respond answered or refused cleanly": () =>
      verdict === "win" || isAcceptableLoss(verdict),
  });
  return { verdict, res, body: json(res), appointmentId: target };
}

export default function (data) {
  const { appointmentId } = runReschedule(data);
  sleep(1);
  // Decline rather than accept: accept re-validates through the allocator and
  // consumes the fixture, while decline ends the request and leaves the slots
  // in the consultant's queue, which a repeat iteration can act on again.
  runRespond(data, appointmentId, "decline");
  sleep(2);
}

export function handleSummary(data) {
  return summaryOutputs(data);
}
