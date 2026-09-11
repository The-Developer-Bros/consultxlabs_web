/**
 * Post-event chat channel lifecycle (#1134 P1-17).
 *
 * Nothing ever ended a webinar or class chat. `getWebinarIdsForUser` and
 * `getClassIdsForUser` have no date or status filter, so the reconcile pass
 * could never mark a finished event stale and attendees stayed members forever.
 * Channel count and membership grew without bound on a product billed per MAU,
 * and there was no retention answer for a compliance review.
 *
 * Two stages, decided in #1134:
 *   +7 days after the session ends  → FREEZE. History stays readable, nobody can
 *      post. Long enough for the real follow-up Q&A, which for a class or cohort
 *      is often where the value lands; short enough to bound membership.
 *   +retention days                 → DELETE, hard. Reuses the org's existing
 *      `streamRecordingRetentionDays` dial (default 90) rather than inventing a
 *      second number to explain.
 *
 * Both stages are idempotent: deleting a deleted channel is a no-op, and since
 * 2026-08-23 freezing is LEDGERED — `Webinar.chatFrozenAt` / `Class.chatFrozenAt`
 * records that a channel was frozen, so already-frozen channels are filtered out
 * before any Stream call is made. Before the ledger every daily run re-issued
 * `updatePartial({frozen:true})` for every channel in the 7–90d age band:
 * value-idempotent, but each no-op burned an UpdateChannelPartial call until
 * ~300 of them tripped Stream's per-minute cap (the 2026-08-23 10:36 IST alert)
 * and the resulting 429s opened the circuit breaker and starved the delete stage.
 */
import "dotenv/config";

import * as Sentry from "@sentry/nextjs";

import prisma from "../../lib/prisma";
import {
  getStreamChatClient,
  isStreamConfigured,
  withStreamCircuitBreaker,
} from "../../lib/stream-client";
import {
  getChannelTypeFromId,
  CLASS_PREFIX,
  WEBINAR_PREFIX,
} from "../../lib/stream-channel-ids";
import { bookingOrgId, getDmChannelId } from "../../lib/stream-utils";
import { dmEligibleStatusFilter } from "../../lib/stream/dm-eligibility-statuses";
import { sendSystemMessage } from "../../lib/stream/system-message";
import {
  chunk,
  pause,
  STREAM_BATCH_LIMIT,
  STREAM_BATCH_PAUSE_MS,
  STREAM_CONCURRENCY_LIMIT,
} from "../../lib/stream/batch";
import { withCronLock } from "../../lib/cron/with-cron-lock";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { runJob } from "../../lib/observability/job-sentry";
// Lifecycle thresholds moved out of this job module (review F-HIGH-2): the
// dashboard sync now applies the SAME age math when building its expected-set,
// and importing constants from here would drag dotenv/job wiring into the
// request path. Names are re-exported so existing consumers/tests are
// unchanged.
import {
  DAY_MS,
  DEFAULT_RETENTION_DAYS,
  FREEZE_AFTER_DAYS,
} from "../../lib/stream/channel-lifecycle";

export { DEFAULT_RETENTION_DAYS, FREEZE_AFTER_DAYS };

/**
 * How far back to look for events still needing a stage applied.
 *
 * Without a lower bound this scanned EVERY ended webinar and class in history on
 * every daily run, and re-issued `deleteChannels` for channels deleted months
 * ago. Both stages are idempotent so nothing broke, but the work grew
 * monotonically with the product and every run paid for it in Stream API calls.
 *
 * An event is fully handled once `endsAt + retentionDays` has passed, so
 * anything older than the longest retention we honour has nothing left to do.
 * The margin is what makes that safe: the job can be down for a month, or an org
 * can carry a longer dial than the default, and the window still covers it.
 * `MAX_RETENTION_DAYS` is deliberately generous rather than derived — being
 * wrong in this direction costs one wasted query, being wrong the other way
 * leaves a channel undeleted forever.
 */
const MAX_RETENTION_DAYS = 365;
const LOOKBACK_MARGIN_DAYS = 60;

/** Backstop so one pathological run cannot hold the cron open indefinitely. */
const MAX_EVENTS_PER_RUN = 5_000;

/**
 * Freeze pacing. The UpdateChannelPartial endpoint is capped at 300 req/min
 * APP-WIDE (shared with maintenance drain freeze/unfreeze), so the freeze loop
 * must never run flat-out: width `STREAM_CONCURRENCY_LIMIT` concurrent plus
 * this sleep between chunks averages under STREAM_TARGET_REQUESTS_PER_MINUTE
 * even if Stream answers instantly, leaving half the budget for live traffic.
 *
 * STREAM_FREEZE_PACING_MS can only SLOW this down. Values below the safe
 * minimum clamp up to STREAM_BATCH_PAUSE_MS — accepting a literal 0 would let
 * one env typo recreate the very burst this job exists to prevent.
 */
const PARSED_PACING_MS = Number(process.env.STREAM_FREEZE_PACING_MS);
const FREEZE_PACING_MS =
  Number.isFinite(PARSED_PACING_MS) && PARSED_PACING_MS >= 0
    ? Math.max(PARSED_PACING_MS, STREAM_BATCH_PAUSE_MS)
    : STREAM_BATCH_PAUSE_MS;

/**
 * Hard cap on freezes per run. At default pacing, 600 freezes ≈ 4 min, which
 * fits the workflow's 10-minute timeout alongside the delete stage; anything
 * left over resumes next run (the ledger makes resume cheap — only unstamped
 * channels are retried).
 */
const MAX_FREEZE_PER_RUN = 600;

/**
 * How long a PAIR must be dormant before their direct-message channel freezes.
 *
 * Deliberately not `FREEZE_AFTER_DAYS`. An event ends on a schedule and its chat
 * has a natural tail — seven days covers the follow-up Q&A and then the thing is
 * over. A consulting relationship does not end on a schedule: a fortnight
 * between sessions is ordinary, and freezing a consultee out of the channel they
 * use to reach their consultant would be a product regression dressed up as
 * hygiene.
 *
 * Ninety days of no booked session at all is a different claim: at that point
 * the relationship has plausibly ended, and the channel is membership and MAU
 * we are carrying for nothing.
 *
 * Dormancy is measured on the PAIR, never on an appointment. DM ids are keyed
 * on the pair (`dm-<a>-<b>`), and `DM_ELIGIBLE_STATUSES` includes `COMPLETED`
 * precisely so a finished booking keeps the conversation open — so a
 * per-appointment trigger would freeze a live relationship the moment one of
 * its bookings completed.
 */
const DM_FREEZE_AFTER_DORMANT_DAYS = 90;

/** Bound on the DM scan, mirroring MAX_EVENTS_PER_RUN for the event stage. */
const MAX_DM_PAIRS_PER_RUN = 5_000;

/**
 * Chat retention for a personal (non-org) DM.
 *
 * Matches the `Organization.chatRetentionDays` default. Personal bookings have
 * no org to carry a dial, and 365 is the same answer for the same reason: chat
 * is the cheaper of the two retained assets to keep and the more expensive to
 * have thrown away.
 */
const DEFAULT_CHAT_RETENTION_DAYS = 365;

export interface ExpireEventChannelsResult {
  frozen: number;
  deleted: number;
  skippedAlreadyFrozen: number;
  /** DM channels frozen because the pair went dormant. */
  dmFrozen: number;
  /** DM channels UNfrozen because the pair booked again. */
  dmUnfrozen: number;
  /**
   * DM channels SENT for hard deletion. Not a count of channels that existed:
   * `deleteChannels` is idempotent and reports a task id, so a pair past
   * retention is re-sent each run until it ages out of the scan window.
   */
  dmDeleteRequests: number;
  errors: string[];
  success: boolean;
}

/**
 * One direct-message channel, and the state of the relationship behind it.
 *
 * `bookingIds` is every booking the pair shares, because the ledger is a
 * property of the PAIR and stamping one row would let a second booking look
 * unfrozen while the channel was not.
 */
interface DmPairRow {
  channelId: string;
  /** Latest slot end across every DM-eligible booking the pair shares. */
  lastActivityAt: Date;
  retentionDays: number;
  /** MAX(chatFrozenAt) across the pair. Null = never frozen. */
  chatFrozenAt: Date | null;
  consultationIds: string[];
  subscriptionIds: string[];
}

interface EventRow {
  channelId: string;
  endsAt: Date;
  retentionDays: number;
  /** Null = the ledger says this channel has never been frozen. */
  chatFrozenAt: Date | null;
  entity: { kind: "webinar"; id: string } | { kind: "class"; id: string };
}

/**
 * Every webinar/class whose last slot has ended, with the retention window that
 * applies to it. One query rather than per-appointment lookups: this runs daily
 * over the whole history, so N+1 here would be thousands of round-trips.
 */
async function loadEndedEvents(): Promise<EventRow[]> {
  const now = new Date();
  const lookbackFrom = new Date(
    now.getTime() - (MAX_RETENTION_DAYS + LOOKBACK_MARGIN_DAYS) * DAY_MS,
  );
  const appointments = await prisma.appointment.findMany({
    where: {
      OR: [{ webinar: { isNot: null } }, { class: { isNot: null } }],
      slotsOfAppointment: {
        some: { endsAt: { lt: now, gte: lookbackFrom } },
      },
    },
    take: MAX_EVENTS_PER_RUN,
    orderBy: { createdAt: "desc" },
    select: {
      webinar: { select: { id: true, chatFrozenAt: true } },
      class: { select: { id: true, chatFrozenAt: true } },
      organization: { select: { streamRecordingRetentionDays: true } },
      slotsOfAppointment: {
        select: { endsAt: true },
        orderBy: { endsAt: "desc" },
        take: 1,
      },
    },
  });

  // A webinar spans many appointments (one per attendee cohort) but ONE channel,
  // so collapse to the latest end across all of them. Freezing on the earliest
  // would cut off a channel whose later sessions are still running.
  const byChannel = new Map<string, EventRow>();
  for (const appointment of appointments) {
    const endsAt = appointment.slotsOfAppointment[0]?.endsAt;
    if (!endsAt) continue;

    const channelId = appointment.webinar
      ? `${WEBINAR_PREFIX}${appointment.webinar.id}`
      : appointment.class
        ? `${CLASS_PREFIX}${appointment.class.id}`
        : null;
    if (!channelId) continue;

    let entity: EventRow["entity"];
    let chatFrozenAt: Date | null;
    if (appointment.webinar) {
      entity = { kind: "webinar", id: appointment.webinar.id };
      chatFrozenAt = appointment.webinar.chatFrozenAt;
    } else if (appointment.class) {
      entity = { kind: "class", id: appointment.class.id };
      chatFrozenAt = appointment.class.chatFrozenAt;
    } else {
      continue;
    }

    const retentionDays =
      appointment.organization?.streamRecordingRetentionDays ??
      DEFAULT_RETENTION_DAYS;

    const existing = byChannel.get(channelId);
    if (!existing || existing.endsAt < endsAt) {
      byChannel.set(channelId, {
        channelId,
        endsAt,
        retentionDays,
        chatFrozenAt,
        entity,
      });
    } else if (existing.chatFrozenAt === null && chatFrozenAt !== null) {
      // Same channel seen via a second cohort's appointment: keep the newest
      // end but don't lose the ledger stamp the earlier row carried.
      existing.chatFrozenAt = chatFrozenAt;
      existing.entity = entity;
    }
  }
  return Array.from(byChannel.values());
}

/**
 * Every DM-eligible pair, collapsed to one row per CHANNEL.
 *
 * One query per booking kind rather than per pair: this runs daily over the
 * whole history, and a per-pair lookup would be thousands of round trips.
 *
 * A pair can hold several channels at once — the id is a function of the pair
 * AND the funding context, so the same two people have a personal `dm-` channel
 * and a separate `dmo-` one per organization that funded a booking. Grouping by
 * channel id rather than by pair keeps those apart, which matters because an
 * org-funded relationship can end while the personal one continues.
 */
async function loadDmPairs(): Promise<{
  pairs: DmPairRow[];
  /**
   * True when either query filled its page, so the pair set may be INCOMPLETE.
   *
   * This is not a performance note. `lastActivityAt` is a MAX across every
   * booking a pair shares, so a missing booking does not merely omit a pair —
   * it can make a present one look dormant when it is not.
   */
  truncated: boolean;
}> {
  const now = new Date();
  const orgRetention = await loadOrgChatRetention();

  // The scan window has to cover the LONGEST retention any org has actually
  // configured, not the constant. `MAX_RETENTION_DAYS` is 365; an org that sets
  // `chatRetentionDays` to 500 would have every one of its bookings dropped by
  // the bound below and get no deletion at all — silently, and in the direction
  // of keeping data forever rather than deleting it early.
  const configuredMax = Math.max(
    MAX_RETENTION_DAYS,
    DEFAULT_CHAT_RETENTION_DAYS,
    ...orgRetention.values(),
  );
  const lookbackFrom = new Date(
    now.getTime() - (configuredMax + LOOKBACK_MARGIN_DAYS) * DAY_MS,
  );

  const bookingSelect = {
    id: true,
    chatFrozenAt: true,
    requestedBy: { select: { user: { select: { id: true } } } },
  } as const;

  const [consultations, subscriptions] = await Promise.all([
    prisma.consultation.findMany({
      where: { status: dmEligibleStatusFilter() },
      take: MAX_DM_PAIRS_PER_RUN,
      orderBy: { requestedAt: "desc" },
      select: {
        ...bookingSelect,
        consultationPlan: {
          select: {
            organizationId: true,
            consultantProfile: { select: { user: { select: { id: true } } } },
          },
        },
        appointment: {
          select: {
            organizationId: true,
            slotsOfAppointment: {
              select: { endsAt: true },
              orderBy: { endsAt: "desc" },
              take: 1,
            },
          },
        },
      },
    }),
    prisma.subscription.findMany({
      where: { status: dmEligibleStatusFilter() },
      take: MAX_DM_PAIRS_PER_RUN,
      orderBy: { requestedAt: "desc" },
      select: {
        ...bookingSelect,
        subscriptionPlan: {
          select: {
            organizationId: true,
            consultantProfile: { select: { user: { select: { id: true } } } },
          },
        },
        appointments: {
          select: {
            organizationId: true,
            slotsOfAppointment: {
              select: { endsAt: true },
              orderBy: { endsAt: "desc" },
              take: 1,
            },
          },
        },
      },
    }),
  ]);

  const byChannel = new Map<string, DmPairRow>();

  const add = (
    kind: "consultation" | "subscription",
    bookingId: string,
    consultantUserId: string | undefined,
    consulteeUserId: string | undefined,
    orgId: string | null,
    lastActivityAt: Date | null,
    chatFrozenAt: Date | null,
  ) => {
    if (!consultantUserId || !consulteeUserId || !lastActivityAt) return;
    // Older than the longest retention we honour: the channel is already gone,
    // and re-deriving its id every night costs a Stream call for nothing.
    if (lastActivityAt < lookbackFrom) return;

    let channelId: string;
    try {
      channelId = getDmChannelId(
        consultantUserId,
        consulteeUserId,
        orgId ?? undefined,
      );
    } catch {
      // `getDmChannelId` throws on a self-pair. Seed data has produced those;
      // they have no channel to expire.
      return;
    }

    const existing = byChannel.get(channelId);
    if (!existing) {
      byChannel.set(channelId, {
        channelId,
        lastActivityAt,
        retentionDays: orgId
          ? (orgRetention.get(orgId) ?? DEFAULT_CHAT_RETENTION_DAYS)
          : DEFAULT_CHAT_RETENTION_DAYS,
        chatFrozenAt,
        consultationIds: kind === "consultation" ? [bookingId] : [],
        subscriptionIds: kind === "subscription" ? [bookingId] : [],
      });
      return;
    }

    // The pair is as dormant as their MOST RECENT booking, not their oldest.
    if (existing.lastActivityAt < lastActivityAt) {
      existing.lastActivityAt = lastActivityAt;
    }
    // MAX(chatFrozenAt): any stamp across the pair means the channel is frozen.
    if (
      chatFrozenAt &&
      (!existing.chatFrozenAt || existing.chatFrozenAt < chatFrozenAt)
    ) {
      existing.chatFrozenAt = chatFrozenAt;
    }
    if (kind === "consultation") existing.consultationIds.push(bookingId);
    else existing.subscriptionIds.push(bookingId);
  };

  for (const c of consultations) {
    add(
      "consultation",
      c.id,
      c.consultationPlan?.consultantProfile?.user?.id,
      c.requestedBy?.user?.id,
      bookingOrgId(c),
      c.appointment?.slotsOfAppointment[0]?.endsAt ?? null,
      c.chatFrozenAt,
    );
  }

  for (const sub of subscriptions) {
    // A subscription holds many appointments; the pair is as active as the
    // latest slot across all of them.
    let latest: Date | null = null;
    for (const appt of sub.appointments) {
      const endsAt = appt.slotsOfAppointment[0]?.endsAt;
      if (endsAt && (!latest || latest < endsAt)) latest = endsAt;
    }
    add(
      "subscription",
      sub.id,
      sub.subscriptionPlan?.consultantProfile?.user?.id,
      sub.requestedBy?.user?.id,
      bookingOrgId(sub),
      latest,
      sub.chatFrozenAt,
    );
  }

  return {
    pairs: Array.from(byChannel.values()),
    truncated:
      consultations.length >= MAX_DM_PAIRS_PER_RUN ||
      subscriptions.length >= MAX_DM_PAIRS_PER_RUN,
  };
}

/**
 * Per-org chat retention, read once rather than per booking.
 *
 * Deliberately reads every organization rather than only those with a
 * DM-eligible booking. The scan window below is derived from the LARGEST
 * configured `chatRetentionDays`, and that has to include orgs whose bookings
 * this run has not loaded yet — narrowing the query to the orgs already seen
 * would make the window depend on the page, which is the same
 * incomplete-input-drives-a-destructive-decision shape the truncation guard
 * exists to prevent. Two columns across a table with tens of rows.
 */
async function loadOrgChatRetention(): Promise<Map<string, number>> {
  const orgs = await prisma.organization.findMany({
    select: { id: true, chatRetentionDays: true },
  });
  return new Map(orgs.map((o) => [o.id, o.chatRetentionDays]));
}

/**
 * Sort every pair into freeze / unfreeze / delete.
 *
 * Pure, and extracted from `runDmStage` so it can be tested directly and so
 * neither function carries the whole decision — the combined version tripped
 * SonarCloud's cognitive-complexity gate at 20 against a limit of 15.
 */
function classifyDmPairs(
  pairs: DmPairRow[],
  now: number,
): {
  toFreeze: DmPairRow[];
  toUnfreeze: DmPairRow[];
  toDelete: DmPairRow[];
  alreadyFrozen: number;
} {
  const toFreeze: DmPairRow[] = [];
  const toUnfreeze: DmPairRow[] = [];
  const toDelete: DmPairRow[] = [];
  let alreadyFrozen = 0;

  for (const pair of pairs) {
    const dormantFor = now - pair.lastActivityAt.getTime();

    if (dormantFor >= pair.retentionDays * DAY_MS) {
      // Past retention wins, as in the event stage: no point freezing something
      // being deleted.
      toDelete.push(pair);
    } else if (dormantFor >= DM_FREEZE_AFTER_DORMANT_DAYS * DAY_MS) {
      // Each redundant updatePartial spends one of the app-wide 300/min budget,
      // which is how the 2026-08-23 burst happened.
      if (pair.chatFrozenAt) alreadyFrozen++;
      else toFreeze.push(pair);
    } else if (pair.chatFrozenAt) {
      // Active again, and the ledger says we froze them. This is the branch the
      // whole design turns on.
      toUnfreeze.push(pair);
    }
  }

  return { toFreeze, toUnfreeze, toDelete, alreadyFrozen };
}

/**
 * The DM stage: freeze a dormant pair's channel, UNFREEZE one that came back,
 * and delete past retention.
 *
 * The unfreeze is not optional and is the reason this cannot simply reuse the
 * event stage. An event never resumes, so a frozen event channel stays frozen
 * correctly. A pair does resume — they book again — and without a reversal the
 * first thing a returning consultee would find is a channel they cannot post
 * in, with Stream granting `use-frozen-channel` to no role and therefore no
 * error text explaining why. Freezing without unfreezing would be a worse bug
 * than never freezing at all.
 *
 * Shares the run's pacing budget with the event stage rather than running as a
 * second cron. UpdateChannelPartial is capped at 300/min APP-WIDE, so two jobs
 * each pacing to half of it independently could still collide; one job that
 * paces across both stages cannot.
 *
 * @param freezeBudget how many freeze-class calls the event stage left unspent.
 */
async function runDmStage(
  chat: ReturnType<typeof getStreamChatClient>,
  result: ExpireEventChannelsResult,
  freezeBudget: number,
): Promise<void> {
  const { pairs, truncated } = await loadDmPairs();
  if (pairs.length === 0) return;

  const { toFreeze, toUnfreeze, toDelete, alreadyFrozen } = classifyDmPairs(
    pairs,
    Date.now(),
  );
  result.skippedAlreadyFrozen += alreadyFrozen;

  // Unfreeze FIRST, and outside the budget. A frozen channel belonging to an
  // active pair is a live user-facing fault; a dormant pair staying unfrozen
  // one more day is not. Spending the run's remaining calls on freezes while a
  // returning consultee cannot message their consultant would be the wrong way
  // round.
  await applyDmFrozen(chat, toUnfreeze, false, result);

  const freezeBatch = toFreeze.slice(0, Math.max(freezeBudget, 0));
  await applyDmFrozen(chat, freezeBatch, true, result);
  if (toFreeze.length > freezeBatch.length) {
    result.errors.push(
      `dm freeze cap: deferred ${toFreeze.length - freezeBatch.length} channels to the next run`,
    );
  }

  // Delete — but NEVER from a page that may be incomplete.
  //
  // Both booking queries cap at MAX_DM_PAIRS_PER_RUN and order by
  // `requestedAt`, which is not the key dormancy is measured on. A long-running
  // booking is requested once and then generates sessions for years, so it
  // sorts old and is the first thing a full page drops. If a pair keeps one
  // low-activity booking on the page and loses its active one, `lastActivityAt`
  // is computed from the stale row, the pair classifies as past retention, and
  // `hard_delete: true` destroys the chat history of a live consulting
  // relationship. That is not recoverable.
  //
  // Freezing on a truncated page IS recoverable — the next run sees the pair as
  // active and unfreezes it — so only the delete stage is withheld. The run is
  // marked unsuccessful so the cron reports it rather than passing green while
  // silently skipping work.
  if (truncated) {
    result.success = false;
    result.errors.push(
      `dm scan truncated at ${MAX_DM_PAIRS_PER_RUN} bookings — delete stage skipped ` +
        `(${toDelete.length} candidates held back; an incomplete page can make an active pair look dormant)`,
    );
    return;
  }

  // Same batching as the event stage; `deleteChannels` caps at 100 cids.
  for (const batch of chunk(toDelete, STREAM_BATCH_LIMIT)) {
    const cids = batch.map(
      (pair) => `${getChannelTypeFromId(pair.channelId)}:${pair.channelId}`,
    );
    try {
      await withStreamCircuitBreaker(() =>
        chat.deleteChannels(cids, { hard_delete: true }),
      );
      // Counts channels SENT for deletion, not channels that existed to delete.
      // `deleteChannels` is idempotent and returns a task id rather than a
      // per-cid outcome, so a pair that crossed retention is re-sent on every
      // run until it ages past the scan window — bounded by `lookbackFrom`
      // (largest configured retention + 60 days), not unbounded, but real. The
      // name says requests because that is what the number is.
      result.dmDeleteRequests += cids.length;
    } catch (error) {
      result.success = false;
      result.errors.push(
        `dm delete batch: ${error instanceof Error ? error.message : String(error)}`,
      );
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "stream" } },
      );
    }
  }
}

/**
 * Set `frozen` on a set of DM channels and move the pair ledger to match.
 *
 * The ledger write happens only after Stream confirms, and only for the pairs
 * it confirmed. Stamping ahead of the call could leave a channel unfrozen
 * forever while the ledger claimed otherwise; a missed stamp only costs one
 * redundant call on the next run.
 *
 * Every booking the pair shares is written, not just one. The read side takes
 * MAX(chatFrozenAt) across the pair, so a partial write would let a second
 * booking report the channel as unfrozen when it is not.
 */
async function applyDmFrozen(
  chat: ReturnType<typeof getStreamChatClient>,
  pairs: DmPairRow[],
  frozen: boolean,
  result: ExpireEventChannelsResult,
): Promise<void> {
  if (pairs.length === 0) return;
  const verb = frozen ? "freeze" : "unfreeze";

  for (const [batchIdx, batch] of chunk(
    pairs,
    STREAM_CONCURRENCY_LIMIT,
  ).entries()) {
    if (batchIdx > 0) await pause(FREEZE_PACING_MS);

    await announceFreeze(batch, frozen);

    const outcomes = await Promise.allSettled(
      batch.map((pair) =>
        withStreamCircuitBreaker(() =>
          chat
            .channel(getChannelTypeFromId(pair.channelId), pair.channelId)
            .updatePartial({ set: { frozen } }),
        ),
      ),
    );

    const consultationIds: string[] = [];
    const subscriptionIds: string[] = [];
    outcomes.forEach((outcome, i) => {
      const pair = batch[i];
      if (outcome.status === "fulfilled") {
        if (frozen) result.dmFrozen++;
        else result.dmUnfrozen++;
        consultationIds.push(...pair.consultationIds);
        subscriptionIds.push(...pair.subscriptionIds);
      } else {
        // A DM that was never created is the common case — channels are minted
        // lazily on first message — not a failure worth failing the run over.
        result.errors.push(
          `dm ${verb} ${pair.channelId}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
        );
      }
    });

    await writeDmLedger(consultationIds, subscriptionIds, frozen, verb, result);
  }
}

/**
 * Tell the pair why the channel is about to stop accepting messages.
 *
 * Before the freeze, not after: Stream grants `use-frozen-channel` to no role,
 * so a frozen channel refuses every send with no error text the user ever sees
 * — including this one, if it were sent second.
 *
 * Only on the way in. Unfreezing needs no announcement; the channel simply
 * works again, and a "you may post now" notice in a conversation nobody has
 * touched for three months is noise.
 */
async function announceFreeze(
  batch: DmPairRow[],
  frozen: boolean,
): Promise<void> {
  if (!frozen) return;
  await Promise.allSettled(
    batch.map((pair) =>
      sendSystemMessage(
        pair.channelId,
        `This conversation has been archived after ${DM_FREEZE_AFTER_DORMANT_DAYS} days without a session. ` +
          "The history stays available, and booking again reopens it.",
        { event: "chat_frozen_dormant" },
      ),
    ),
  );
}

/**
 * Move the pair ledger to match what Stream confirmed.
 *
 * Every booking the pair shares, not just one: the read side takes
 * MAX(chatFrozenAt) across the pair, so a partial write would let a second
 * booking report the channel as unfrozen when it is not.
 */
async function writeDmLedger(
  consultationIds: string[],
  subscriptionIds: string[],
  frozen: boolean,
  verb: string,
  result: ExpireEventChannelsResult,
): Promise<void> {
  const stamp = frozen ? new Date() : null;
  try {
    await Promise.all([
      consultationIds.length > 0 &&
        prisma.consultation.updateMany({
          where: { id: { in: consultationIds } },
          data: { chatFrozenAt: stamp },
        }),
      subscriptionIds.length > 0 &&
        prisma.subscription.updateMany({
          where: { id: { in: subscriptionIds } },
          data: { chatFrozenAt: stamp },
        }),
    ]);
  } catch (err) {
    result.errors.push(
      `dm ${verb} ledger: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function expireEventChannels(): Promise<ExpireEventChannelsResult> {
  return withCronLock("expire-event-channels", { failMode: "open" }, () =>
    expireEventChannelsUnlocked(),
  );
}

async function expireEventChannelsUnlocked(): Promise<ExpireEventChannelsResult> {
  const result: ExpireEventChannelsResult = {
    frozen: 0,
    deleted: 0,
    skippedAlreadyFrozen: 0,
    dmFrozen: 0,
    dmUnfrozen: 0,
    dmDeleteRequests: 0,
    errors: [],
    success: true,
  };

  if (!isStreamConfigured()) {
    // Not a no-op success. The cron reports `success` and exits 0 on it, so a
    // Stream config that silently went missing — the exact failure #1134 found
    // in production, where the webhook secret was simply unset on Netlify —
    // would show up as a green nightly run for as long as it lasted.
    result.errors.push("Stream is not configured — nothing to do");
    result.success = false;
    return result;
  }

  const now = Date.now();
  const events = await loadEndedEvents();

  const toFreeze: EventRow[] = [];
  const toDelete: string[] = [];

  for (const event of events) {
    const age = now - event.endsAt.getTime();
    if (age >= event.retentionDays * DAY_MS) {
      // Past retention wins: no point freezing something we are deleting.
      toDelete.push(event.channelId);
    } else if (age >= FREEZE_AFTER_DAYS * DAY_MS) {
      if (event.chatFrozenAt) {
        // Ledger hit — the channel is already frozen on Stream. Re-issuing the
        // updatePartial would succeed as a no-op but still spend one
        // UpdateChannelPartial call, which is exactly how the 2026-08-23 burst
        // happened. Skip without touching the API.
        result.skippedAlreadyFrozen++;
      } else {
        toFreeze.push(event);
      }
    }
  }

  const chat = getStreamChatClient();

  // Freeze. Per-channel rather than bulk because Stream has no batch freeze, so
  // the chunk size here is a CONCURRENCY width and not a payload ceiling —
  // chunking by STREAM_BATCH_LIMIT fired a hundred simultaneous requests at an
  // app that also serves live user traffic. allSettled so one missing channel
  // cannot abort the run. Paced (see FREEZE_PACING_MS) so even a full backlog
  // cannot breach Stream's app-wide 300/min cap for this endpoint, and capped
  // per run so the workflow timeout is never at risk.
  const freezeBatch = toFreeze.slice(0, MAX_FREEZE_PER_RUN);
  for (const [batchIdx, batch] of chunk(
    freezeBatch,
    STREAM_CONCURRENCY_LIMIT,
  ).entries()) {
    if (batchIdx > 0) {
      await pause(FREEZE_PACING_MS);
    }
    const outcomes = await Promise.allSettled(
      batch.map((event) =>
        withStreamCircuitBreaker(() =>
          chat
            .channel(getChannelTypeFromId(event.channelId), event.channelId)
            .updatePartial({ set: { frozen: true } }),
        ),
      ),
    );
    const stamped: { webinarIds: string[]; classIds: string[] } = {
      webinarIds: [],
      classIds: [],
    };
    outcomes.forEach((outcome, i) => {
      const event = batch[i];
      if (outcome.status === "fulfilled") {
        result.frozen++;
        stamped[
          event.entity.kind === "webinar" ? "webinarIds" : "classIds"
        ].push(event.entity.id);
      } else {
        // A channel that was never created is the common case (chat is lazy),
        // not a failure worth failing the run over. A 429 is quota, not an
        // outage — pacing should make it rare, and it must not fail the run.
        result.errors.push(
          `freeze ${event.channelId}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
        );
      }
    });
    // Stamp the ledger only after the Stream call succeeded, best-effort per
    // model. A missed stamp costs one redundant freeze next run — safe by
    // construction; a premature stamp could leave a channel unfrozen forever,
    // which is not.
    try {
      await Promise.all([
        stamped.webinarIds.length > 0 &&
          prisma.webinar.updateMany({
            where: { id: { in: stamped.webinarIds } },
            data: { chatFrozenAt: new Date() },
          }),
        stamped.classIds.length > 0 &&
          prisma.class.updateMany({
            where: { id: { in: stamped.classIds } },
            data: { chatFrozenAt: new Date() },
          }),
      ]);
    } catch (err) {
      result.errors.push(
        `ledger stamp: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (toFreeze.length > freezeBatch.length) {
    result.errors.push(
      `freeze cap: deferred ${toFreeze.length - freezeBatch.length} channels to the next run`,
    );
  }

  // Delete. `deleteChannels` takes cids and caps at 100 per request; it is
  // async server-side (it returns a task id), which is fine — we are not
  // waiting on the outcome, and a re-run of an already-deleted channel is a
  // no-op.
  for (const batch of chunk(toDelete, STREAM_BATCH_LIMIT)) {
    const cids = batch.map(
      (channelId) => `${getChannelTypeFromId(channelId)}:${channelId}`,
    );
    try {
      await withStreamCircuitBreaker(() =>
        chat.deleteChannels(cids, { hard_delete: true }),
      );
      result.deleted += cids.length;
    } catch (error) {
      result.success = false;
      result.errors.push(
        `delete batch: ${error instanceof Error ? error.message : String(error)}`,
      );
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "stream" } },
      );
    }
  }

  // #1280 PR F — direct messages, keyed on pair dormancy.
  //
  // Runs after the event stage and takes what is left of the same per-run
  // freeze cap. UpdateChannelPartial is capped at 300/min APP-WIDE, so the two
  // stages must not each spend a full budget: a heavy event night should slow
  // the DM sweep, not breach the cap alongside it. Whatever is deferred is
  // picked up tomorrow — the ledger makes resume cheap.
  //
  // Wrapped, because a DM failure must not lose the event stage's result. This
  // function is the only writer of `frozen`/`deleted`, and the caller reports
  // them.
  try {
    await runDmStage(chat, result, MAX_FREEZE_PER_RUN - result.frozen);
  } catch (error) {
    result.success = false;
    result.errors.push(
      `dm stage: ${error instanceof Error ? error.message : String(error)}`,
    );
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
  }

  console.log(
    JSON.stringify({
      event: "expire_event_channels",
      frozen: result.frozen,
      skippedAlreadyFrozen: result.skippedAlreadyFrozen,
      deleted: result.deleted,
      dmFrozen: result.dmFrozen,
      dmUnfrozen: result.dmUnfrozen,
      dmDeleteRequests: result.dmDeleteRequests,
      errorCount: result.errors.length,
      timestamp: new Date().toISOString(),
    }),
  );

  return result;
}

if (require.main === module) {
  runJob("expire-event-channels", async () => {
    await abortIfMaintenance("expire-event-channels");
    try {
      const result = await expireEventChannels();
      console.log(
        `Events — frozen: ${result.frozen}  deleted: ${result.deleted}\n` +
          `DMs    — frozen: ${result.dmFrozen}  unfrozen: ${result.dmUnfrozen}  delete-requests: ${result.dmDeleteRequests}\n` +
          `Errors: ${result.errors.length}`,
      );
      if (!result.success) process.exitCode = 1;
    } finally {
      // In a `finally` so a throw cannot leak the pool. `runJob` reports the
      // error and lets it propagate, which skipped this line entirely.
      await prisma.$disconnect();
    }
  });
}
