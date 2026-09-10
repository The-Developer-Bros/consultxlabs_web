/**
 * Stream Channel Org Backfill (#B2 Stream.io org tagging)
 *
 * One-shot backfill that stamps `custom.organization_id` on existing Stream
 * Chat channels for org-scoped Appointments. New channels created after this
 * commit pick up the tag automatically via the helpers in
 * `actions/stream/chat/channel.action.ts`; this script is for the bookings
 * that pre-date the rollout.
 *
 * STRATEGY
 * --------
 * 1. Walk every `Appointment` whose `organizationId IS NOT NULL`.
 * 2. Map appointmentType → channel id pattern + channel type:
 *      - WEBINAR      → team `webinar-<webinarId>`
 *      - CLASS        → team `class-<classId>`
 *      - CONSULTATION → messaging `dm-<sortedConsultantId>-<consulteeId>`
 *      - SUBSCRIPTION → messaging `dm-<sortedConsultantId>-<consulteeId>`
 *   Consultation/subscription DMs are pair-scoped, not event-scoped — the
 *   same DM may be tagged with the org of the *first* org-scoped event seen,
 *   which matches the helper's behaviour going forward.
 * 3. For each channel, query Stream and skip if `organization_id` is already
 *    set (idempotent).
 * 4. Otherwise call `channel.updatePartial({ set: { organization_id: orgId } })`.
 *
 * STREAM VIDEO CALLS
 * ------------------
 * TODO: Backfilling video calls is more involved — Stream Video's query API
 * takes a `MeetingSession.streamCallId` lookup per slot. Skipping for now;
 * new calls created after this commit get tagged via `lib/meeting.ts`.
 *
 * EXTERNAL API CALLS
 * ------------------
 * This script makes external Stream Chat API calls. Run it ONCE after the
 * #B2 schema migration lands. Re-running is safe (idempotent).
 *
 * MANUAL SMOKE-TEST STEPS
 * -----------------------
 * 1. Ensure `NEXT_PUBLIC_STREAM_API_KEY` and `STREAM_API_SECRET` are set
 *    in the env (load `.env` if needed).
 * 2. Verify Prisma DB pointer matches the env you intend to backfill.
 * 3. Dry-run first: `npx tsx scripts/stream/backfill-channel-org.ts --dry-run`
 *    The script reports `would update` counts without mutating Stream.
 * 4. Inspect a sample channel via Stream's dashboard / `queryChannels` to
 *    confirm `custom.organization_id` is missing on a known-org Appointment.
 * 5. Live run: `npx tsx scripts/stream/backfill-channel-org.ts`
 * 6. Verify via Stream's dashboard that the same channel now carries
 *    `custom.organization_id = <expected orgId>`.
 * 7. Re-run the script — it should report 0 updates (idempotent).
 */

// #1280 PR 7 — this script has never been runnable, and this line is why.
//
// Every other script in scripts/stream/ loads dotenv; this one did not. `tsx`
// does not read `.env` on its own, so `lib/redis.ts` — pulled in transitively
// by `lib/stream-client` — hit its module-scope env check with
// UPSTASH_REDIS_REST_URL undefined and threw before a single line of this file
// executed:
//
//   Error: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set
//     at Object.<anonymous> (lib/redis.ts:389:16)
//
// Which explains the finding that prompted this PR. The backfill was written,
// reviewed and merged, and zero of 886 channels carry `organization_id` —
// because the script that was supposed to tag them could not start. Same shape
// as the CI database guards in #1285, which printed "DATABASE_URL unset —
// skipping" on every run for the same reason.
import "dotenv/config";

import prisma from "@/lib/prisma";
import { getStreamChatClient } from "@/lib/stream-client";
import { bookingOrgId, getDmChannelId } from "@/lib/stream-utils";

interface BackfillResult {
  scanned: number;
  alreadyTagged: number;
  updated: number;
  channelMissing: number;
  errors: number;
}

interface BackfillOptions {
  dryRun?: boolean;
  /**
   * Page size for Appointment iteration. Default 200 — small enough that the
   * Prisma payload fits comfortably, large enough to keep network round-trips
   * down. Stream's `updatePartial` is per-channel so the bottleneck is
   * Stream's rate limit, not our DB pagination.
   */
  pageSize?: number;
}

type ChannelTarget = {
  channelType: "messaging" | "team";
  channelId: string;
};

/**
 * Resolve the Stream channel that covers a given org-scoped Appointment.
 * Returns null when the appointment doesn't have enough info (e.g., a
 * webinar appointment with no webinarId — shouldn't happen in practice).
 */
async function resolveChannelTarget(appointment: {
  id: string;
  appointmentType: string;
  /** Non-null for every row this backfill walks; part of the DM channel key. */
  organizationId: string | null;
  webinarId: string | null;
  classId: string | null;
  consultationId: string | null;
  subscriptionId: string | null;
}): Promise<ChannelTarget | null> {
  switch (appointment.appointmentType) {
    case "WEBINAR":
      if (!appointment.webinarId) return null;
      return {
        channelType: "team",
        channelId: `webinar-${appointment.webinarId}`,
      };
    case "CLASS":
      if (!appointment.classId) return null;
      return {
        channelType: "team",
        channelId: `class-${appointment.classId}`,
      };
    case "CONSULTATION": {
      if (!appointment.consultationId) return null;
      const consultation = await prisma.consultation.findUnique({
        where: { id: appointment.consultationId },
        select: {
          consultationPlan: {
            select: {
              organizationId: true,
              consultantProfile: { select: { user: { select: { id: true } } } },
            },
          },
          requestedBy: { select: { user: { select: { id: true } } } },
        },
      });
      const consultantId =
        consultation?.consultationPlan?.consultantProfile?.user?.id;
      const consulteeId = consultation?.requestedBy?.user?.id;
      if (!consultantId || !consulteeId) return null;
      return {
        channelType: "messaging",
        // Shared resolver: an org-HOSTED plan wins over the appointment's own
        // tag, or this targets a channel that was never made.
        channelId: getDmChannelId(
          consultantId,
          consulteeId,
          bookingOrgId({
            consultationPlan: consultation?.consultationPlan,
            appointment,
          }),
        ),
      };
    }
    case "SUBSCRIPTION": {
      if (!appointment.subscriptionId) return null;
      const subscription = await prisma.subscription.findUnique({
        where: { id: appointment.subscriptionId },
        select: {
          subscriptionPlan: {
            select: {
              organizationId: true,
              consultantProfile: { select: { user: { select: { id: true } } } },
            },
          },
          requestedBy: { select: { user: { select: { id: true } } } },
        },
      });
      const consultantId =
        subscription?.subscriptionPlan?.consultantProfile?.user?.id;
      const consulteeId = subscription?.requestedBy?.user?.id;
      if (!consultantId || !consulteeId) return null;
      return {
        channelType: "messaging",
        // Same resolver as createSubscriptionChannel.
        channelId: getDmChannelId(
          consultantId,
          consulteeId,
          bookingOrgId({
            subscriptionPlan: subscription?.subscriptionPlan,
            appointment,
          }),
        ),
      };
    }
    default:
      // TRIAL or unknown type — no channel to backfill
      return null;
  }
}

export async function backfillChannelOrg(
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const { dryRun = false, pageSize = 200 } = opts;
  const result: BackfillResult = {
    scanned: 0,
    alreadyTagged: 0,
    updated: 0,
    channelMissing: 0,
    errors: 0,
  };

  const client = getStreamChatClient();

  // De-dup map: channelId → orgId we'll stamp. DM channels are pair-scoped,
  // so multiple appointments resolve to the same channelId — we want only
  // one updatePartial per channel. First-org-wins matches the helper's
  // create-time semantics.
  const queued = new Map<string, { target: ChannelTarget; orgId: string }>();

  let cursor: string | null = null;
  // The disable directive that used to sit here was already dead — this config
  // does not flag `while (true)` — and eslint reports an unused directive as a
  // warning of its own. Removed rather than left, now that this file is being
  // touched anyway.
  while (true) {
    type AppointmentRow = {
      id: string;
      appointmentType: string;
      organizationId: string | null;
      webinarId: string | null;
      classId: string | null;
      consultationId: string | null;
      subscriptionId: string | null;
    };

    const page: AppointmentRow[] = await prisma.appointment.findMany({
      where: { organizationId: { not: null } },
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        appointmentType: true,
        organizationId: true,
        webinarId: true,
        classId: true,
        consultationId: true,
        subscriptionId: true,
      },
    });

    if (page.length === 0) break;

    for (const appointment of page) {
      result.scanned++;
      if (!appointment.organizationId) continue;
      const target = await resolveChannelTarget(appointment);
      if (!target) continue;
      // First-org-wins for shared DMs; consistent with the helper's runtime
      // behaviour where the channel is created on the first event booking.
      if (!queued.has(target.channelId)) {
        queued.set(target.channelId, {
          target,
          orgId: appointment.organizationId,
        });
      }
    }

    cursor = page[page.length - 1].id;
    if (page.length < pageSize) break;
  }

  // Walk the queued channels and tag each via updatePartial.
  // `Array.from` keeps the loop ES5-iteration-safe — `Map.entries()` is
  // a `MapIterator` which trips TS's downlevelIteration check otherwise.
  for (const [channelId, { target, orgId }] of Array.from(queued.entries())) {
    try {
      const channel = client.channel(target.channelType, channelId);

      // #1280 PR 7 — `queryChannels`, NOT `channel.query()`.
      //
      // `channel.query()` maps to Stream's GetOrCreateChannel endpoint, which
      // under server-side auth refuses without an author:
      //
      //   StreamChat error code 4: GetOrCreateChannel failed with error:
      //   "either data.created_by or data.created_by_id must be provided
      //    when using server side auth."
      //
      // So every channel this script touched errored before it could read
      // anything — the second reason (after the missing dotenv above) that the
      // backfill has never tagged a single channel. It is also the same trap
      // #1270 hit on the video side: a read-shaped call that can create is not
      // a read.
      //
      // `queryChannels` with an id filter cannot create. If the channel does
      // not exist it returns an empty page, which is the right answer for a
      // backfill — there is nothing to tag, and minting one here would create
      // an empty channel purely as a side effect of inspecting it.
      const [found] = await client.queryChannels(
        { type: target.channelType, id: { $eq: channelId } },
        {},
        { limit: 1, state: false, watch: false, presence: false },
      );

      if (!found) {
        result.channelMissing++;
        continue;
      }

      // `found.data` is typed as `ChannelResponse` but at runtime carries
      // arbitrary custom fields. Cast through `unknown` for the type system.
      const channelData = found.data as unknown as
        | Record<string, unknown>
        | undefined;
      const existing = channelData?.organization_id;
      if (typeof existing === "string" && existing.length > 0) {
        result.alreadyTagged++;
        continue;
      }

      if (dryRun) {
        console.log(
          `[dry-run] would tag channel=${channelId} with organization_id=${orgId}`,
        );
        result.updated++;
        continue;
      }

      // updatePartial's `set` is typed as `Partial<ChannelResponse>` which
      // doesn't include our custom `organization_id`; runtime accepts any
      // custom field. Cast to satisfy the strict generic.
      await channel.updatePartial({
        set: { organization_id: orgId } as unknown as Parameters<
          typeof channel.updatePartial
        >[0]["set"],
      });
      result.updated++;
      console.log(`tagged channel=${channelId} organization_id=${orgId}`);
    } catch (err) {
      // Stream returns a `StreamChat.errors.STREAM_CHAT_NOT_FOUND` for a
      // missing channel. Other errors (rate limit, network) bubble up as
      // generic — count and continue so a single failure doesn't abort
      // the whole run.
      const message = err instanceof Error ? err.message : String(err);
      if (/does not exist|not found/i.test(message)) {
        result.channelMissing++;
        continue;
      }
      result.errors++;
      console.error(`error backfilling channel=${channelId}:`, message);
    }
  }

  return result;
}

// Allow `npx tsx scripts/stream/backfill-channel-org.ts [--dry-run]`
async function main() {
  // #1280 PR 7 — dry run is the DEFAULT, and `--apply` writes.
  //
  // This was the other way round: `--dry-run` was opt-in, so the bare command
  // wrote to production Stream. Every other script in scripts/stream/ defaults
  // to a dry run, so an operator who has learned that these are safe to run and
  // read before applying got the opposite behaviour from this one. `--dry-run`
  // is still accepted so any runbook or muscle memory carrying it keeps working.
  const apply = process.argv.includes("--apply");
  const dryRun = !apply;
  console.log(
    `Starting Stream channel org backfill (${dryRun ? "DRY RUN — pass --apply to write" : "LIVE"})...`,
  );
  const result = await backfillChannelOrg({ dryRun });
  console.log("Backfill complete:", result);
  // Exit cleanly so npx tsx returns 0
  process.exit(result.errors > 0 ? 1 : 0);
}

// Detect "ran directly" — tsx sets `import.meta.url` to the script file's
// URL. We avoid `require.main === module` since this file is ESM-style.
if (
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module
) {
  main().catch((err) => {
    console.error("Fatal error in backfill:", err);
    process.exit(1);
  });
}
