// Post-storm integrity check, through the public read routes only.
//
// The storm's own thresholds assert that no MORE than one buyer received a 2xx
// for the hot slot. This script asserts the same invariant from the other side —
// what the database actually holds — because a 2xx is a claim and a confirmed
// slot is a fact, and the two have diverged before (#827's confirm-time recheck
// exists precisely because they did).
//
// Two invariants:
//
//   1. No consultant-minute holds two confirmed bookings.
//   2. No event holds more registrations than it has seats.
//
// Neither can be read from a purpose-built endpoint, because none exists. There
// is no capacity route: `readEventCapacity` is module-private to the checkout
// operation and `getWebinarCapacity` is server-only, so the registered count is
// re-derived here by de-duplicating participant ids. And the public availability
// route reports only FREE slots — a booked minute simply vanishes from it, with
// no flag distinguishing a confirmed booking from a tentative hold — so the
// double-booking check runs against `GET /api/slots/appointments`, which is
// self-scoped and needs the consultant's own session.
//
// Run after every storm:
//   k6 run --env BASE_URL=... --env VERIFY_COOKIE=... \
//          --env CONSULTANT_PROFILE_IDS=... load-tests/booking/verify-integrity.js

import { check } from "k6";
import { Counter } from "k6/metrics";
import {
  CONSULTANT_PROFILE_IDS,
  EVENT_CAPACITY,
  EVENT_EXCLUDE_USER_IDS,
  EVENT_ID,
  EVENT_TYPE,
  VERIFY_COOKIE,
} from "./lib/config.js";
import { get, json } from "./lib/http.js";
import { windowEndMs, windowStartMs } from "./lib/window.js";

const violations = new Counter("integrity_violations");
const confirmedSlots = new Counter("integrity_confirmed_slots");

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    // The whole purpose of the script. A breach here fails the gate.
    integrity_violations: ["count==0"],
    checks: ["rate==1"],
  },
};

/**
 * A slot counts against the consultant-minute only when it is a live, confirmed
 * hold. `isTentative` false means the payment landed; a CANCELLED or RESCHEDULED
 * completion status and a non-null `deletedAt` are the two tombstones this
 * codebase uses, and a tombstoned slot releases the minute.
 */
function isConfirmed(slot) {
  return (
    slot.isTentative === false &&
    (slot.deletedAt === null || slot.deletedAt === undefined) &&
    slot.completionStatus !== "CANCELLED" &&
    slot.completionStatus !== "RESCHEDULED"
  );
}

function checkConsultantMinutes() {
  const startDate = new Date(windowStartMs()).toISOString();
  const endDate = new Date(windowEndMs()).toISOString();

  for (const profileId of CONSULTANT_PROFILE_IDS) {
    const res = get(
      `/api/slots/appointments?consultantProfileId=${profileId}&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`,
      { cookie: VERIFY_COOKIE, tag: "verify_slots" },
    );
    const ok = check(res, {
      [`slot oracle readable for ${profileId}`]: (r) => r.status === 200,
    });
    if (!ok) {
      // A 403 here means VERIFY_COOKIE is not the consultant who owns this
      // profile and is not ADMIN/STAFF — the route refuses any other filter.
      console.error(
        `verify: /api/slots/appointments answered ${res.status} for ${profileId}; VERIFY_COOKIE must own the profile or be ADMIN/STAFF`,
      );
      violations.add(1);
      continue;
    }

    const body = json(res) || {};
    const appointments = body.data || [];
    const byMinute = {};
    for (const appointment of appointments) {
      for (const slot of appointment.slotsOfAppointment || []) {
        if (!isConfirmed(slot)) continue;
        confirmedSlots.add(1);
        const key = slot.startsAt;
        byMinute[key] = (byMinute[key] || 0) + 1;
      }
    }

    const doubled = Object.keys(byMinute).filter((key) => byMinute[key] > 1);
    check(null, {
      [`no double-booked minute for ${profileId}`]: () => doubled.length === 0,
    });
    if (doubled.length > 0) {
      violations.add(doubled.length);
      console.error(
        `verify: consultant ${profileId} holds ${doubled.length} double-booked minute(s): ${doubled.join(", ")}`,
      );
    } else {
      console.log(
        `verify: consultant ${profileId} — ${Object.keys(byMinute).length} confirmed minute(s), none doubled`,
      );
    }
  }
}

function checkEventCapacity() {
  if (!EVENT_ID) return;
  const kind = EVENT_TYPE === "CLASS" ? "class" : "webinar";
  const res = get(`/api/participants/${kind}/${EVENT_ID}`, {
    cookie: VERIFY_COOKIE,
    tag: "verify_participants",
  });
  const ok = check(res, {
    "participant roster readable": (r) => r.status === 200,
  });
  if (!ok) {
    // Owner, an ACCEPTED collaborator with canSeeAttendees, or ADMIN/STAFF.
    console.error(
      `verify: /api/participants/${kind}/${EVENT_ID} answered ${res.status}; VERIFY_COOKIE must own the event or be ADMIN/STAFF`,
    );
    violations.add(1);
    return;
  }

  const body = json(res) || {};
  const event = body.webinarEvent || body.classEvent || {};
  const plan = event.webinarPlan || event.classPlan || {};
  // The instance override wins and a null inherits the plan, which is what
  // `effectiveMaxParticipants` does server-side.
  const max = event.maxParticipants ?? plan.maxParticipants ?? EVENT_CAPACITY;

  // De-duplicated, because a seat is a USER and the roster can carry the same
  // user twice (one row per slot). Counting rows would invent over-capacity
  // violations out of a roster the server considers exactly full.
  const seats = new Set();
  for (const participant of body.participants || []) {
    if (EVENT_EXCLUDE_USER_IDS.indexOf(participant.id) !== -1) continue;
    seats.add(participant.id);
  }
  const registered = seats.size;

  check(null, {
    "event is not over capacity": () => registered <= max,
  });
  if (registered > max) {
    violations.add(registered - max);
    console.error(
      `verify: ${kind} ${EVENT_ID} holds ${registered} registrations against ${max} seats`,
    );
  } else {
    console.log(
      `verify: ${kind} ${EVENT_ID} — ${registered}/${max} seats taken`,
    );
  }
  // Every user connected to a slot occupies a seat, including one whose payment
  // is still PENDING, so this count includes live tentative holds by design.
}

export default function () {
  if (!VERIFY_COOKIE) {
    throw new Error(
      "VERIFY_COOKIE is required — both integrity oracles are self-scoped routes.",
    );
  }
  // With neither oracle configured this script checks nothing and then reports
  // PASS, because `integrity_violations` stays at zero. A verdict nobody
  // measured is worse than no verdict at all.
  if (CONSULTANT_PROFILE_IDS.length === 0 && !EVENT_ID) {
    throw new Error(
      "No integrity oracle configured — set CONSULTANT_PROFILE_IDS (the double-booking sweep), EVENT_ID (the capacity check), or both.",
    );
  }
  checkConsultantMinutes();
  checkEventCapacity();
}

export function handleSummary(data) {
  const breaches = data.metrics.integrity_violations?.values?.count ?? 0;
  const result = {
    verdict: breaches === 0 ? "PASS" : "FAIL",
    violations: breaches,
    confirmedSlotsSeen:
      data.metrics.integrity_confirmed_slots?.values?.count ?? 0,
    checkedAt: new Date().toISOString(),
  };
  return {
    stdout: JSON.stringify(result, null, 2),
    "integrity-result.json": JSON.stringify(result, null, 2),
  };
}
