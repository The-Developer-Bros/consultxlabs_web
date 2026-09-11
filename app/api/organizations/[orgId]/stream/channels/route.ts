/**
 * GET /api/organizations/[orgId]/stream/channels
 *
 * Lists Stream Chat channels tagged with `custom.organization_id = <orgId>`.
 * Surfaces the messaging side of an org's footprint to MANAGER+ org workspace operators
 * for compliance, member-management, and audit workflows. Backed by Stream's
 * native `queryChannels` so we don't shadow channel state in our DB.
 *
 * AUTH: MANAGER+ on the target org (matches the rest of the org-workspace
 * surface area; viewing chat metadata is on par with viewing audit logs).
 *
 * PAGINATION: Stream caps `queryChannels` at 30 per call; we ship 20/page
 * with offset-based pagination to keep the URL simple. `?page=` is 1-based.
 *
 * RESPONSE: minimal shape so the client can render a directory table
 * without fetching messages.
 *
 * The `/stream/calls` sibling this once deferred now exists, and it writes a
 * `STREAM_CALLS_EXPORTED` audit row on every successful pull. This half
 * shipped without one, so reading the roster of who messages whom inside an
 * org left no trace — even though the rows returned (channel name, member
 * count, last activity) are a social graph, which is why the two endpoints are
 * documented together as a compliance pair. Every successful GET now writes
 * `STREAM_CHANNELS_EXPORTED`, matching the sibling.
 *
 * Message bodies are never fetched (`message_limit: 0`) and never will be:
 * ADR 20 puts session content with the participants, and a chat channel is
 * session content.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { getStreamChatClient } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";

const QuerySchema = z.object({
  // 1-based page number; offset is computed server-side. Capped at a
  // generous 50 (~1000 channels) to keep Stream's pagination from
  // degrading; orgs above that should use search/filter UI.
  page: z.coerce.number().int().min(1).max(50).default(1),
});

const PAGE_SIZE = 20;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { page } = parsed.data;
  const offset = (page - 1) * PAGE_SIZE;

  try {
    const client = getStreamChatClient();
    // Stream's filter language: top-level keys map to channel custom data
    // when prefixed (or matched implicitly via custom_field_name). Since
    // our helper writes `organization_id` at the top level of channel
    // custom data, the equality match below is the canonical form.
    const channels = await client.queryChannels(
      // Cast through unknown — stream-chat's `ChannelFilters` typing is
      // strict about known fields and rejects custom keys, but the
      // server accepts arbitrary custom-data filters at runtime.
      { organization_id: { $eq: orgId } } as unknown as Parameters<
        typeof client.queryChannels
      >[0],
      [{ last_message_at: -1 }],
      {
        limit: PAGE_SIZE,
        offset,
        // Don't fetch messages — we only need metadata for the list.
        message_limit: 0,
        // Don't fetch full member rosters; member_count is enough.
        member_limit: 0,
      },
    );

    const rows = channels.map((ch) => {
      const data = ch.data as Record<string, unknown> | undefined;
      const lastMessageAt = data?.last_message_at;
      return {
        cid: ch.cid,
        id: ch.id,
        type: ch.type,
        name: typeof data?.name === "string" ? (data.name as string) : null,
        memberCount:
          typeof data?.member_count === "number"
            ? (data.member_count as number)
            : null,
        lastMessageAt:
          typeof lastMessageAt === "string"
            ? lastMessageAt
            : lastMessageAt instanceof Date
              ? lastMessageAt.toISOString()
              : null,
      };
    });

    // Mirrors the /stream/calls sibling: one row per pull, volume in
    // `details` so the log carries the shape of the export without echoing
    // the channel list back into it.
    //
    // Isolated from the outer try: `rows` is already built by this point, so a
    // DB hiccup here would otherwise surface as a 502 "Failed to query
    // channels" for a Stream query that in fact succeeded — and send Sentry
    // chasing the wrong subsystem. The read still returns; the audit gap is
    // reported on its own terms.
    try {
      await prisma.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.STREAM_CHANNELS_EXPORTED,
          description: `Listed ${rows.length} Stream chat channels`,
          details: { page, pageSize: PAGE_SIZE, count: rows.length },
        },
      });
    } catch (auditErr) {
      Sentry.captureException(
        auditErr instanceof Error ? auditErr : new Error(String(auditErr)),
        { tags: { subsystem: "enterprise", surface: "stream-channels-audit" } },
      );
      streamLogger.error("Failed to record channel export audit", auditErr, {
        orgId,
        page,
      });
    }

    return NextResponse.json({
      page,
      pageSize: PAGE_SIZE,
      // `hasMore` is best-effort — Stream doesn't return a total count.
      // If we got a full page back, assume another exists.
      hasMore: rows.length === PAGE_SIZE,
      rows,
    });
  } catch (err) {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    streamLogger.error("Failed to query org channels", err, { orgId, page });
    return NextResponse.json(
      {
        error: "Failed to query channels",
        detail: err instanceof Error ? err.message : "unknown",
      },
      { status: 502 },
    );
  }
}
