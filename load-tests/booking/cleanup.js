// Undo what the run created, through the same HTTP routes it used.
//
// This is not optional housekeeping. ONE Supabase project serves both dev and
// production, so every row a load run writes is a production row: a real
// appointment on a real consultant's calendar, a real seat on a real event, and
// — because a mock purchase commits as SUCCEEDED and creates ConsultantEarnings
// in the same request — a real earnings line. The run is not finished until this
// script has.
//
// Discovery is by window, not by id. The checkout response carries neither an
// appointment id nor a payment id, only the gateway order id, and there is no
// route that lists a user's payments by order id. So the harness books every
// consultation into one declared window (lib/window.js) and cleanup cancels
// anything of the buyer pool's that starts inside it.
//
// Three passes:
//   1. Cancel consultations and subscriptions in the window.
//      POST /api/appointments/[id]/cancel — the CAS refuses a second cancel, so
//      re-running this script is safe.
//   2. Leave event seats.
//      DELETE /api/participants/{webinar,class}/[id]?userId=... — idempotent,
//      answers 200 with `removed: false` when the seat is already gone.
//   3. (optional) Cancel PENDING gateway holds.
//      Only relevant against a production build, where `isMockPayment` is
//      ignored and checkout leaves a real pending payment. Needs
//      CONSULTEE_PROFILE_IDS. Skipping it is safe: those holds carry a
//      thirty-minute `expiresAt` and the abandoned-payment sweep expires them.
//
// Pacing is deliberate. The event-mutation limiter is 10 per minute per user, so
// a cancel loop that does not pause measures the limiter and leaves rows behind.
//
//   k6 run --env BASE_URL=... --env BUYER_COOKIES=... load-tests/booking/cleanup.js

import { sleep } from "k6";
import { Counter } from "k6/metrics";
import {
  CLEANUP_MAX_PER_USER,
  CONSULTEE_PROFILE_IDS,
  EVENT_ID,
  EVENT_TYPE,
} from "./lib/config.js";
import { del, get, json, post } from "./lib/http.js";
import { establishSessions } from "./lib/session.js";
import { isInWindow } from "./lib/window.js";

const cancelled = new Counter("cleanup_cancelled");
const seatsReleased = new Counter("cleanup_seats_released");
const holdsCancelled = new Counter("cleanup_holds_cancelled");
const failures = new Counter("cleanup_failures");

export const options = {
  vus: 1,
  iterations: 1,
  // A run that cannot clean up must fail loudly; the alternative is silently
  // leaving production rows behind.
  thresholds: { cleanup_failures: ["count==0"] },
  // Cancels can be slow: a whole-event cancel refunds every participant.
  setupTimeout: "2m",
};

export function setup() {
  return establishSessions();
}

/** The signed-in user's id, needed to release an event seat. */
function selfId(cookie) {
  const res = get("/api/auth/get-session", { cookie, tag: "cleanup_session" });
  const body = json(res);
  return body?.user?.id ?? null;
}

/**
 * How many pages of a hundred the discovery sweep will read before giving up.
 * Reaching it is a cleanup failure, not a ceiling: the rows past it are still
 * in the shared production database.
 */
const MAX_PAGES = 5;

/** Every appointment of this credential's that starts inside the window. */
function appointmentsInWindow(cookie) {
  const found = [];
  let truncated = false;
  // pageSize, not limit — and the response echoes it back as perPage.
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = get(`/api/appointments?page=${page}&pageSize=100`, {
      cookie,
      tag: "cleanup_list",
    });
    if (res.status !== 200) {
      console.error(`cleanup: appointment list answered ${res.status}`);
      failures.add(1);
      return found;
    }
    const body = json(res) || {};
    const items = body.items || [];
    for (const item of items) {
      const slots = item.slotsOfAppointment || [];
      // A slot already tombstoned needs no cancel, and cancelling an
      // already-cancelled appointment is a 409 the CAS is right to give.
      const live = slots.filter(
        (slot) =>
          slot.completionStatus !== "CANCELLED" &&
          (slot.deletedAt === null || slot.deletedAt === undefined),
      );
      if (live.some((slot) => isInWindow(slot.startsAt))) {
        found.push(item.id);
      }
    }
    if (items.length === 0) break;
    if (page * 100 >= (body.total ?? 0)) break;
    if (page === MAX_PAGES) truncated = true;
  }
  // Stopping early used to be silent, so a run that created more rows than the
  // sweep could see reported CLEAN while the rest stayed on real calendars.
  // Both ceilings are now failures, and the verdict says NEEDS ATTENTION.
  if (truncated || found.length > CLEANUP_MAX_PER_USER) {
    console.error(
      `cleanup: discovery stopped early — ${found.length} appointment(s) found, ` +
        `CLEANUP_MAX_PER_USER=${CLEANUP_MAX_PER_USER}, pages read=${MAX_PAGES}. ` +
        `Rows in the marked window may remain; raise CLEANUP_MAX_PER_USER and re-run.`,
    );
    failures.add(1);
  }
  return found.slice(0, CLEANUP_MAX_PER_USER);
}

function cancelAppointments(cookie, ids) {
  for (const id of ids) {
    const res = post(
      `/api/appointments/${id}/cancel`,
      { reason: "NO_LONGER_NEEDED", notes: "load gate #874 cleanup" },
      { cookie, tag: "cleanup_cancel" },
    );
    if (res.status === 200) {
      cancelled.add(1);
    } else if (res.status === 409 || res.status === 404) {
      // Already terminal, or someone else got there first. Both are done.
      console.log(`cleanup: ${id} already settled (${res.status})`);
    } else if (res.status === 429) {
      // The limiter, not a failure. Wait out the window and retry once.
      console.warn(`cleanup: rate limited on ${id}, backing off 60s`);
      sleep(60);
      const retry = post(
        `/api/appointments/${id}/cancel`,
        { reason: "NO_LONGER_NEEDED", notes: "load gate #874 cleanup" },
        { cookie, tag: "cleanup_cancel" },
      );
      if (retry.status === 200) cancelled.add(1);
      else if (retry.status !== 409 && retry.status !== 404) failures.add(1);
    } else {
      console.error(
        `cleanup: cancel ${id} answered ${res.status}: ${String(res.body).slice(0, 200)}`,
      );
      failures.add(1);
    }
    // 10 per minute per user; six seconds keeps every credential under it.
    sleep(6.5);
  }
}

function releaseSeat(cookie, userId) {
  if (!EVENT_ID || !userId) return;
  const kind = EVENT_TYPE === "CLASS" ? "class" : "webinar";
  const res = del(
    `/api/participants/${kind}/${EVENT_ID}?userId=${encodeURIComponent(userId)}`,
    { cookie, tag: "cleanup_seat" },
  );
  if (res.status === 200) {
    const body = json(res) || {};
    if (body.removed) seatsReleased.add(1);
  } else if (res.status === 400) {
    // "Cannot leave an event that has already started" — the fixture event
    // began mid-run. Report it; a human has to unwind that one.
    console.error(
      `cleanup: seat release refused for ${userId}: ${String(res.body).slice(0, 200)}`,
    );
    failures.add(1);
  } else if (res.status !== 404) {
    console.error(`cleanup: seat release answered ${res.status}`);
    failures.add(1);
  }
  sleep(6.5);
}

function cancelPendingHolds(cookie, consulteeProfileId) {
  if (!consulteeProfileId) return;
  const res = get(
    `/api/dashboard/consultee/${consulteeProfileId}/pending-payments`,
    { cookie, tag: "cleanup_pending_list" },
  );
  if (res.status !== 200) {
    console.warn(
      `cleanup: pending-payment list answered ${res.status} for ${consulteeProfileId} — skipping pass 3`,
    );
    return;
  }
  const body = json(res) || {};
  for (const payment of (body.pendingPayments || []).slice(
    0,
    CLEANUP_MAX_PER_USER,
  )) {
    // The path parameter is the Payment ROW id, not the gateway order id.
    const drop = del(`/api/checkout/pending/${payment.id}`, {
      cookie,
      tag: "cleanup_pending_cancel",
    });
    if (drop.status === 200) holdsCancelled.add(1);
    else if (drop.status !== 409 && drop.status !== 404) failures.add(1);
    // cancelPendingLimiter is 10 per minute per user, same shape as above.
    sleep(6.5);
  }
}

export default function (data) {
  data.buyers.forEach((cookie, index) => {
    const userId = selfId(cookie);
    const ids = appointmentsInWindow(cookie);
    console.log(
      `cleanup: credential ${index} — ${ids.length} appointment(s) in the marked window`,
    );
    cancelAppointments(cookie, ids);
    releaseSeat(cookie, userId);
    cancelPendingHolds(cookie, CONSULTEE_PROFILE_IDS[index]);
  });
}

export function handleSummary(data) {
  const count = (name) => data.metrics[name]?.values?.count ?? 0;
  const result = {
    cancelled: count("cleanup_cancelled"),
    seatsReleased: count("cleanup_seats_released"),
    pendingHoldsCancelled: count("cleanup_holds_cancelled"),
    failures: count("cleanup_failures"),
    verdict: count("cleanup_failures") === 0 ? "CLEAN" : "NEEDS ATTENTION",
    finishedAt: new Date().toISOString(),
  };
  return {
    stdout: JSON.stringify(result, null, 2),
    "cleanup-result.json": JSON.stringify(result, null, 2),
  };
}
