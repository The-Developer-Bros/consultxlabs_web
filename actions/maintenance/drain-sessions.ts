"use server";

/**
 * Video Call Draining — called before entering OFFLINE maintenance phase.
 *
 * Finds active meeting sessions, stops any in-progress recordings,
 * notifies participants, and ends calls via Stream server SDK.
 */

import * as Sentry from "@sentry/nextjs";
import { transitionSlotCompletion } from "@/lib/booking/transitions";
import { RecordingService } from "@/lib/stream/recording-service";
import {
  getStreamChatClient,
  getStreamVideoClient,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { getChannelTypeFromId } from "@/lib/stream-channel-ids";
import {
  chunk,
  pause,
  STREAM_BATCH_PAUSE_MS,
  STREAM_CONCURRENCY_LIMIT,
} from "@/lib/stream/batch";
import { getEventChannelIdsForAppointment } from "@/lib/stream/appointment-channels";
import prisma from "@/lib/prisma";
import redis, { withCircuitBreaker } from "@/lib/redis";
import { REDIS_KEYS } from "@/lib/maintenance-keys";
import { notifyMaintenanceStarted } from "@/lib/novu/service";

/**
 * A session whose slot ended more than this ago cannot still have anyone in it;
 * it is an unreconciled row, and ending it here would corrupt its history.
 * reconcile-orphaned-sessions owns those.
 */
const LIVE_SESSION_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Hard cap so a backlog can never hold the maintenance transition open. */
const MAX_DRAIN_BATCH = 200;

interface DrainResult {
  drained: number;
  recordingsStopped: number;
  /** Participants warned in-call. The broadcast is counted separately. */
  notified: number;
  errors: string[];
}

export async function drainActiveSessions(): Promise<DrainResult> {
  const result: DrainResult = {
    drained: 0,
    recordingsStopped: 0,
    notified: 0,
    errors: [],
  };

  // #1134 P1-3 — `{ endedAt: null }` alone is not "active", it is "never
  // reconciled". At the time of the audit that matched 1,663 rows going back
  // months, each of which this loop would have ended on Stream serially and
  // stamped `endedReason: "maintenance"` — rewriting the history of sessions
  // that finished in February. Bound it to sessions that could plausibly still
  // have someone in them, and cap the batch so the maintenance transition cannot
  // be held open by a backlog.
  const now = new Date();
  const liveSince = new Date(now.getTime() - LIVE_SESSION_WINDOW_MS);
  const activeSessions = await prisma.meetingSession.findMany({
    where: {
      endedAt: null,
      slotOfAppointment: {
        endsAt: { gte: liveSince },
        // Bounded at BOTH ends. `endsAt >= liveSince` alone also matches every
        // FUTURE session, so a room opened early would be "drained": its call
        // ended and its slot stamped UNVERIFIED for a session that has not
        // happened yet. Only a session that has actually started can be live.
        startsAt: { lte: now },
      },
    },
    take: MAX_DRAIN_BATCH,
    orderBy: { createdAt: "desc" },
    include: {
      slotOfAppointment: {
        include: {
          user: { select: { id: true } },
          appointment: {
            include: {
              consultation: {
                include: {
                  consultationPlan: {
                    select: {
                      consultantProfile: {
                        select: { user: { select: { id: true } } },
                      },
                    },
                  },
                  requestedBy: {
                    select: { user: { select: { id: true } } },
                  },
                },
              },
              subscription: {
                include: {
                  subscriptionPlan: {
                    select: {
                      consultantProfile: {
                        select: { user: { select: { id: true } } },
                      },
                    },
                  },
                  requestedBy: {
                    select: { user: { select: { id: true } } },
                  },
                },
              },
              webinar: {
                include: {
                  webinarPlan: {
                    select: {
                      consultantProfile: {
                        select: { user: { select: { id: true } } },
                      },
                    },
                  },
                },
              },
              class: {
                include: {
                  classPlan: {
                    select: {
                      consultantProfile: {
                        select: { user: { select: { id: true } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (activeSessions.length === 0) {
    return result;
  }

  // Collect all unique user IDs across all active sessions for bulk notification
  const allUserIds = new Set<string>();

  for (const session of activeSessions) {
    // Collect participant user IDs from the slot
    for (const user of session.slotOfAppointment.user) {
      allUserIds.add(user.id);
    }

    // Collect consultant user ID from the appointment
    const appointment = session.slotOfAppointment.appointment;
    const consultantUserId =
      appointment.consultation?.consultationPlan?.consultantProfile?.user?.id ??
      appointment.subscription?.subscriptionPlan?.consultantProfile?.user?.id ??
      appointment.webinar?.webinarPlan?.consultantProfile?.user?.id ??
      appointment.class?.classPlan?.consultantProfile?.user?.id;
    if (consultantUserId) allUserIds.add(consultantUserId);

    // Collect consultee user ID (for 1:1 appointments)
    const consulteeUserId =
      appointment.consultation?.requestedBy?.user?.id ??
      appointment.subscription?.requestedBy?.user?.id;
    if (consulteeUserId) allUserIds.add(consulteeUserId);

    // Step 1: Stop recording if active
    if (session.isRecording) {
      try {
        await RecordingService.stopRecording(session.streamCallId);
        await prisma.meetingSession.update({
          where: { id: session.id },
          data: { isRecording: false },
        });
        result.recordingsStopped++;
      } catch (err) {
        Sentry.captureException(
          err instanceof Error ? err : new Error(String(err)),
          { tags: { subsystem: "maintenance" } },
        );
        result.errors.push(
          `Stop recording ${session.streamCallId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Step 2: End call via Stream server SDK
    let endConfirmed = false;
    try {
      const client = getStreamVideoClient();
      const call = client.video.call(
        STREAM_CALL_TYPE,
        toCallId(session.streamCallId),
      );
      // #1134 — a `maintenance.draining` custom event used to be sent here, and
      // `notified` incremented when the API call succeeded. Nothing in the
      // client subscribes to `call.on("custom", …)`, so it warned nobody, and
      // `end()` fires microseconds later anyway — a toast would not have painted
      // even with a listener. Counting Stream's acknowledgement as a person
      // warned is the same fabricated metric this function is fixed for twenty
      // lines below, so the call and the counter are both gone rather than left
      // to imply a courtesy the product does not provide.
      //
      // Restore it together with a `call.on("custom")` subscriber in
      // MeetingRoom.tsx and a short delay before end() — not before.
      // #473 — fast-fail rather than eat a 30s timeout per session while Stream
      // is degraded; the maintenance window is exactly when that matters.
      await withStreamCircuitBreaker(() => call.end());
      endConfirmed = true;
    } catch (err) {
      result.errors.push(
        `End call ${session.streamCallId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Only record the session as ended if Stream CONFIRMED it. An unconfirmed
    // failure — a breaker trip, a timeout — means the call may still be live and
    // billing while our row claims it finished, and nothing would ever revisit
    // it. Leaving `endedAt` null keeps it visible to the next drain and to
    // reconcile-orphaned-sessions, which is what a still-running call needs.
    if (!endConfirmed) {
      continue;
    }

    // Step 3: Update DB session as ended.
    //
    // #1134 P1-3 — the slot's completionStatus was never set, so a drained
    // session sat SCHEDULED forever: the appointment never completed and the
    // consultant's earnings never became releasable. UNVERIFIED rather than
    // COMPLETED because we cut the call short — a human decides whether it
    // counts.
    //
    // #1146 — guarded per session. This used to be unguarded inside a plain
    // `for`, so one rejection propagated straight out of `drainActiveSessions`
    // and cost two things, not one: every later session in the batch kept
    // running on Stream while the platform went OFFLINE, and — because the chat
    // freeze happens after this loop — NO channel was frozen at all. A single
    // failed row silently skipped the entire maintenance posture.
    //
    // A row left with `endedAt` null is the recoverable outcome:
    // `reconcile-orphaned-sessions` is built to repair exactly that.
    const endedAt = new Date();
    try {
      await prisma.$transaction(async (tx) => {
        await tx.meetingSession.update({
          where: { id: session.id },
          data: { endedAt, endedReason: "maintenance" },
        });
        // CAS (#1319): SCHEDULED or COMPLETED becomes UNVERIFIED — COMPLETED
        // because call.end() above fires the call-ended webhook, which can
        // land before this write; a slot the customer already cancelled keeps
        // its history.
        await transitionSlotCompletion(tx, {
          where: { id: session.slotOfAppointmentId },
          to: "UNVERIFIED",
          data: { completedAt: endedAt },
          allowZero: true,
        });
      });
      result.drained++;
    } catch (err) {
      result.errors.push(
        `Record drained session ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Step 3b: freeze the chat channels for the affected appointments.
  //
  // #1134 P1-4 — nothing froze chat during maintenance. Stream Chat is a
  // separate SaaS, so messages kept flowing while the app was offline and unable
  // to sync or run moderation on any of them. Frozen keeps history readable and
  // refuses new sends.
  await freezeChannelsForSessions(activeSessions, result);

  // Step 4: Broadcast the maintenance notice.
  //
  // #1134 P1-3 — `result.notified = userIdList.length` used to be recorded here,
  // which was a fabricated metric: notifyMaintenanceStarted is a BROADCAST to
  // every user on the platform and takes no recipient list, so the count
  // described a targeted notification that never happened. `notified` now counts
  // the in-call custom events we actually delivered, above.
  const userIdList = Array.from(allUserIds);
  if (userIdList.length > 0) {
    try {
      await notifyMaintenanceStarted({
        phase: "OFFLINE",
        reason: "Platform maintenance starting. Active calls have been ended.",
      });
    } catch (err) {
      Sentry.captureException(
        err instanceof Error ? err : new Error(String(err)),
        { tags: { subsystem: "maintenance" }, level: "warning" },
      );
      result.errors.push(
        `Notification: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(
    JSON.stringify({
      event: "maintenance_sessions_drained",
      ...result,
      timestamp: new Date().toISOString(),
    }),
  );

  return result;
}

/**
 * Freeze the chat channels attached to the appointments we just drained.
 *
 * #1134 P1-4 — a frozen channel keeps its history readable and refuses new
 * sends, which is exactly the maintenance posture: the app is going down and
 * cannot sync, moderate, or notify on anything sent meanwhile. Unfrozen again by
 * the maintenance exit path.
 *
 * Best-effort throughout. A chat freeze failing must never block the OFFLINE
 * transition, which is the whole point of the drain.
 */
async function freezeChannelsForSessions(
  sessions: { slotOfAppointment: { appointmentId: string } }[],
  result: DrainResult,
): Promise<void> {
  const appointmentIds = Array.from(
    new Set(sessions.map((s) => s.slotOfAppointment.appointmentId)),
  );
  if (appointmentIds.length === 0) return;

  try {
    const channelIds = await getEventChannelIdsForAppointment(appointmentIds);
    if (channelIds.length === 0) return;

    const chat = getStreamChatClient();
    // The breaker goes INSIDE the map, not around `Promise.allSettled`.
    // `allSettled` never rejects, so wrapping it meant the breaker recorded a
    // success however many channels failed — it could not trip during the very
    // outage it exists for — and not one failure reached `result.errors`. Per
    // channel, the breaker sees each real failure and each is reported.
    //
    // Chunked by STREAM_CONCURRENCY_LIMIT and PAUSED between batches
    // (2026-08-23): a bare `channelIds.map(...)` fired every updatePartial
    // simultaneously — up to MAX_DRAIN_BATCH at once — and UpdateChannelPartial
    // is capped at 300/min app-wide. Concurrency alone is not rate control:
    // ten parallel calls answered in 100ms is ~6000 req/min. The pause holds
    // this loop under STREAM_TARGET_REQUESTS_PER_MINUTE — half the cap — so it
    // cannot jointly breach 300/min with the paced expire cron even if their
    // windows overlap (they run on different infra, so no shared limiter).
    for (const [batchIdx, batch] of chunk(
      channelIds,
      STREAM_CONCURRENCY_LIMIT,
    ).entries()) {
      if (batchIdx > 0) {
        await pause(STREAM_BATCH_PAUSE_MS);
      }
      const outcomes = await Promise.allSettled(
        batch.map((channelId) =>
          withStreamCircuitBreaker(() =>
            chat
              .channel(getChannelTypeFromId(channelId), channelId)
              .updatePartial({ set: { frozen: true } }),
          ),
        ),
      );
      const frozenInBatch: string[] = [];
      outcomes.forEach((outcome, i) => {
        if (outcome.status === "rejected") {
          result.errors.push(
            `freeze ${batch[i]}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
          );
        } else {
          frozenInBatch.push(batch[i]);
        }
      });

      // #1146 — record what was CONFIRMED frozen, per batch, before the next
      // one starts. Written incrementally rather than once at the end because
      // the drain can be interrupted, and a ledger that only exists after the
      // last batch is no ledger at all for the run that died halfway.
      //
      // Only successes. A channel Stream refused to freeze is not frozen, and
      // listing it would make the unfreeze report work it never did.
      await recordFrozenChannels(frozenInBatch, result);
    }
  } catch (err) {
    result.errors.push(
      `Freeze chat: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Append confirmed-frozen channel ids to the window's ledger.
 *
 * Best-effort by design. If Redis is unreachable the freeze itself still
 * happened and must not be rolled back, so this degrades to the heuristic
 * fallback in `unfreezeChannelsAfterMaintenance` rather than failing the drain.
 * The error is recorded, because a missing ledger downgrades the unfreeze from
 * exact to approximate and whoever reads the drain result should know.
 */
async function recordFrozenChannels(
  channelIds: string[],
  result: DrainResult,
): Promise<void> {
  if (channelIds.length === 0) return;
  try {
    // No breaker fallback, deliberately. A fallback would return its value and
    // swallow the rejection, so a Redis outage during the drain would leave no
    // ledger AND no error — the unfreeze would silently downgrade to the
    // heuristic and nobody would know why. The `catch` below is the fail-open
    // path, and it reports.
    await withCircuitBreaker(() =>
      redis.sadd(
        REDIS_KEYS.FROZEN_CHANNELS,
        // Destructured because Upstash types the first member as required —
        // the guard above already proves there is one, but the array type
        // cannot say so.
        channelIds[0],
        ...channelIds.slice(1),
      ),
    );
  } catch (err) {
    // #1302 review — a FAILED ledger write must be remembered, not just logged.
    //
    // Batches are recorded incrementally, so "the ledger is non-empty" and "the
    // ledger is complete" are different claims. If batch A records, batch B
    // freezes successfully, and B's write fails, the ledger holds only A — and
    // the unfreeze, seeing a non-empty ledger, would reverse A, skip the
    // derived fallback entirely, and leave every channel in B frozen after the
    // OFF transition. Frozen means unwritable by every user AND every admin,
    // with no error text and no visible cause.
    //
    // Best-effort, and its own failure is safe in the right direction: if this
    // marker cannot be written then Redis is unwell, and the unfreeze's own
    // `smembers` will fail too — which its catch already turns into the derived
    // path with an error recorded.
    //
    // An earlier revision also kept a module-level `ledgerComplete` boolean as
    // a belt-and-braces in-process signal. It was removed: it is redundant with
    // the two paths above, and module state outlives a single call, so a warm
    // instance carried one drain's failure into an unrelated later unfreeze.
    try {
      await withCircuitBreaker(() =>
        redis.set(REDIS_KEYS.FROZEN_LEDGER_INCOMPLETE, "1"),
      );
    } catch {
      // Nothing further to escalate to.
    }
    result.errors.push(
      `Record frozen channels: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Undo the maintenance freeze. Called from the maintenance exit path.
 *
 * #1134 — the drain froze group channels and nothing ever unfroze them. Stream
 * grants `use-frozen-channel` to no role by default, so those channels were
 * permanently unwritable by every user AND every admin, with no visible cause.
 * It lives in this PR rather than a later one precisely because this PR
 * introduces the freeze: shipping the two apart leaves a release window in which
 * maintenance silently bricks group chat.
 *
 * Scoped to sessions the drain actually ended (`endedReason: "maintenance"`)
 * within the recent window, so it cannot unfreeze a channel a moderator froze
 * deliberately. `updatePartial` rather than `update`: the latter is a full
 * replace and would delete `organizationId`, `appointmentId` and every other
 * custom field off the channel.
 */
/**
 * How the unfreeze set was determined.
 *
 * `ledger` is the exact set the freeze confirmed; `derived` is the best-effort
 * heuristic used when the ledger is missing. Worth reporting, because the two
 * carry different guarantees — see `resolveChannelsToUnfreeze`.
 */
type UnfreezeSource = "ledger" | "derived" | "none";

export async function unfreezeChannelsAfterMaintenance(): Promise<{
  unfrozen: number;
  errors: string[];
  /** How the set was determined. "ledger" is exact; "derived" is best-effort. */
  source: UnfreezeSource;
}> {
  const result = {
    unfrozen: 0,
    errors: [] as string[],
    source: "none" as UnfreezeSource,
    // #1302 review — provenance and ledger-retirement are different questions.
    // The union path reports "derived" (the set is only best-effort complete)
    // while still CONTAINING ledger entries, so gating retirement on `source`
    // left those entries in `FROZEN_CHANNELS` forever. Not merely untidy: the
    // set is re-unfrozen on every later OFF transition, spending the 300/min
    // budget on it and reopening channels that a different subsystem — the
    // #1303 dormancy sweep — froze deliberately in the meantime.
    usedLedger: false,
  };

  try {
    const channelIds = await resolveChannelsToUnfreeze(result);
    if (channelIds.length === 0) return result;

    const chat = getStreamChatClient();
    // Chunked and paused like the freeze path above — same 300/min
    // UpdateChannelPartial budget, same reason.
    for (const [batchIdx, batch] of chunk(
      channelIds,
      STREAM_CONCURRENCY_LIMIT,
    ).entries()) {
      if (batchIdx > 0) {
        await pause(STREAM_BATCH_PAUSE_MS);
      }
      const outcomes = await Promise.allSettled(
        batch.map((channelId) =>
          withStreamCircuitBreaker(() =>
            chat
              .channel(getChannelTypeFromId(channelId), channelId)
              .updatePartial({ set: { frozen: false } }),
          ),
        ),
      );
      const unfrozenInBatch: string[] = [];
      outcomes.forEach((outcome, i) => {
        if (outcome.status === "fulfilled") {
          result.unfrozen++;
          unfrozenInBatch.push(batch[i]);
        } else
          result.errors.push(
            `unfreeze ${batch[i]}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
          );
      });

      // Retire only what came back unfrozen. A channel Stream refused stays in
      // the ledger deliberately, so the next OFF transition tries it again
      // instead of leaving it silently frozen forever — which is the failure
      // this whole ledger exists to make impossible.
      if (result.usedLedger) {
        await retireFrozenChannels(unfrozenInBatch, result);
      }
    }
  } catch (err) {
    result.errors.push(
      `Unfreeze chat: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // A clean sweep retires the incompleteness marker. Only on a clean one: while
  // any channel is still frozen the ledger remains suspect, and the next OFF
  // transition should keep unioning rather than trusting it.
  if (result.errors.length === 0) {
    try {
      await withCircuitBreaker(() =>
        redis.del(REDIS_KEYS.FROZEN_LEDGER_INCOMPLETE),
      );
    } catch {
      // Leaving the marker set costs redundant unfreeze calls next time, which
      // is the safe direction.
    }
  }

  return result;
}

/**
 * Which channels this OFF transition should unfreeze.
 *
 * The ledger first, because it is the exact set the freeze confirmed. The
 * derived query only when the ledger is empty or unreadable — a Redis eviction,
 * a key that predates this change, or a freeze that ran before the ledger
 * existed. Approximate beats never: a channel left frozen is unwritable by
 * every user AND every admin, with no error message and no visible cause.
 */
async function resolveChannelsToUnfreeze(result: {
  errors: string[];
  source: UnfreezeSource;
  usedLedger: boolean;
}): Promise<string[]> {
  try {
    // Same reasoning as the write: no fallback, because an open breaker read
    // as "the ledger is empty" would silently take the derived path with
    // nothing recorded. The catch below takes it explicitly, and says so.
    const ledger = await withCircuitBreaker(() =>
      redis.smembers(REDIS_KEYS.FROZEN_CHANNELS),
    );

    // #1302 review — only trust the ledger ALONE when it is known complete.
    //
    // An incremental writer means a non-empty ledger can still be missing a
    // batch whose `sadd` failed after an earlier one succeeded. Taking it as
    // the whole answer would skip the derived fallback and leave that batch
    // frozen for good.
    const incomplete = await ledgerMarkedIncomplete();

    if (ledger.length > 0 && !incomplete) {
      result.source = "ledger";
      result.usedLedger = true;
      return ledger;
    }

    if (ledger.length > 0) {
      // Union, not either-or. Unfreezing a channel that was already unfrozen is
      // an idempotent no-op costing one rate-limited call; missing one leaves a
      // conversation permanently unwritable. The asymmetry decides it.
      const derived = await deriveChannelsToUnfreeze();
      result.source = "derived";
      // Ledger ids are in the returned set, so they are still retirable — and
      // `srem` on an id the set never held is a no-op, so passing the derived
      // ids through with them costs nothing.
      result.usedLedger = true;
      return Array.from(new Set([...ledger, ...derived]));
    }
  } catch (err) {
    result.errors.push(
      `Read frozen-channel ledger: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const channelIds = await deriveChannelsToUnfreeze();
  if (channelIds.length > 0) result.source = "derived";
  return channelIds;
}

/** True when a previous drain recorded that its ledger write failed. */
async function ledgerMarkedIncomplete(): Promise<boolean> {
  try {
    return Boolean(
      await withCircuitBreaker(() =>
        redis.get<string>(REDIS_KEYS.FROZEN_LEDGER_INCOMPLETE),
      ),
    );
  } catch {
    // Unreadable is treated as suspect. The cost of being wrong here is a few
    // redundant unfreeze calls; the cost of the other reading is a channel
    // nobody can post in.
    return true;
  }
}

/**
 * The heuristic set, used as a fallback and as the union partner.
 *
 * Every limitation #1146 documents still applies — the six-hour window, the
 * uncapped 200-row take, and the session whose `call.end()` failed and was
 * therefore never stamped. It is a floor, not the mechanism.
 */
async function deriveChannelsToUnfreeze(): Promise<string[]> {
  const drained = await prisma.meetingSession.findMany({
    where: {
      endedReason: "maintenance",
      endedAt: { gte: new Date(Date.now() - LIVE_SESSION_WINDOW_MS) },
    },
    take: MAX_DRAIN_BATCH,
    select: { slotOfAppointment: { select: { appointmentId: true } } },
  });
  if (drained.length === 0) return [];

  return getEventChannelIdsForAppointment(
    Array.from(new Set(drained.map((s) => s.slotOfAppointment.appointmentId))),
  );
}

/** Drop confirmed-unfrozen ids from the ledger. Best-effort, like the write. */
async function retireFrozenChannels(
  channelIds: string[],
  result: { errors: string[] },
): Promise<void> {
  if (channelIds.length === 0) return;
  try {
    await withCircuitBreaker(() =>
      redis.srem(
        REDIS_KEYS.FROZEN_CHANNELS,
        channelIds[0],
        ...channelIds.slice(1),
      ),
    );
  } catch (err) {
    result.errors.push(
      `Retire frozen-channel ledger: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
