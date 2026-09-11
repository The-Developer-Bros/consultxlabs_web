/**
 * GET /api/organizations/[orgId]/stream/calls
 *
 * Org-scoped Stream call + recording metadata export. MANAGER+ gate
 * because the call log is a compliance surface (who met with whom,
 * when, for how long). Reads from local MeetingSession (indexed by
 * organizationId, #674) rather than Stream's API — every page load
 * would otherwise re-do the join over the network.
 *
 * Recordings are joined eagerly so a dashboard listing 50 calls
 * doesn't fan out 50 separate `listRecordings` HTTP calls. The local
 * `Recording` table is the source of truth for the URL +
 * `streamUrlExpiresAt` — the Stream S3 link expiry policy is what
 * forces our 90-day default retention to be longer-than-Stream so
 * we always have a window to transfer to permanent storage.
 *
 * Every successful GET writes a `STREAM_CALLS_EXPORTED` audit row.
 *
 * #1270 — this route used to return `Recording.recordingUrl` verbatim to any
 * MANAGER+. That column holds Stream's pre-signed S3 link: it is valid for
 * fourteen days and carries its own credentials, so anyone who ends up holding
 * the string — a forwarded email, a pasted Slack message, an exported CSV, a
 * third-party BI tool consuming this endpoint — can fetch the video with no
 * session and no membership. It renders nowhere in the product, so the leak
 * was invisible in the UI and plain in the network tab.
 *
 * The export is now metadata-only, and deliberately offers no playback arm at
 * all. ADR 20 is the governing rule — an organization may see THAT a session
 * happened, not what happened in it — and it explicitly considered and
 * rejected "let an org role open session content behind an audit row", on the
 * grounds that the log does not change what a member has to assume about who
 * can watch their coaching session. `lib/api/scope/list-recordings.ts` already
 * enforces the same allowlist on the org recordings page; this route was the
 * arm the July 2026 audit missed.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { minimumRole: "MANAGER" });
  if (access.error) return access.error;

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const perPage = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("perPage") ?? 25)),
  );
  // Only emit recording metadata when the caller asks — most "list
  // calls" hits don't need it and the eager join costs us index
  // hits + bytes on the wire.
  const withRecordings = url.searchParams.get("withRecordings") === "1";

  const where = { organizationId: orgId };

  const [totalResults, sessions] = await prisma.$transaction([
    prisma.meetingSession.count({ where }),
    prisma.meetingSession.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        streamCallId: true,
        platform: true,
        isRecording: true,
        recordingStartedAt: true,
        endedAt: true,
        endedReason: true,
        createdAt: true,
        updatedAt: true,
        recordings: withRecordings
          ? {
              // #1270 — an explicit allowlist, not an `include`, and it names
              // no field that reaches the media: not `recordingUrl`, not
              // `storageUrl`, not `storagePath`, not the thumbnail, the
              // preview clip or the Stream identifiers. What stays is the
              // retention picture the compliance pull actually exists for —
              // whether a recording exists, whether it survived the transfer,
              // how long it runs, and when its Stream link lapses. Same rule
              // and same shape as `recordingMetadataSelect` in
              // lib/api/scope/list-recordings.ts.
              select: {
                id: true,
                title: true,
                status: true,
                storageType: true,
                durationInMinutes: true,
                streamUrlExpiresAt: true,
                createdAt: true,
              },
            }
          : undefined,
      },
    }),
  ]);

  // Single audit row per export call, not per-row, so the audit log
  // isn't drowned in noise. `details.count` carries the volume.
  await prisma.orgAuditLog.create({
    data: {
      organizationId: orgId,
      actorMembershipId: access.member.id,
      category: "SYSTEM",
      action: AUDIT_ACTIONS.SYSTEM.STREAM_CALLS_EXPORTED,
      description: `Listed ${sessions.length} Stream calls`,
      details: { page, perPage, count: sessions.length, withRecordings },
    },
  });

  return NextResponse.json({
    data: sessions,
    meta: { totalResults, page, perPage },
  });
}
