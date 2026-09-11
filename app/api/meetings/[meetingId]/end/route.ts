import { NextRequest, NextResponse } from "next/server";

import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import {
  getStreamVideoClient,
  StreamUnavailableError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { reportSentryError } from "@/lib/observability/report";

/**
 * POST /api/meetings/[meetingId]/end
 *
 * #1270 — ending a call for everyone, decided by the server.
 *
 * `end-call` is granted to `call_member` on the live `default` call type, and
 * the join route gives every participant that role. So the only thing stopping
 * a consultee from ending a consultation was `EndCallButton` not rendering for
 * them — a React conditional over `custom.consultantUserId`, which until this
 * change was a value the browser itself had written when it minted the call.
 * Two lines in devtools ended the session for everyone in the room.
 *
 * This route is the replacement affordance. It re-resolves access from the
 * database and requires the caller to be on the hosting side, so revoking
 * `end-call` from `call_member` in scripts/stream/ensure-call-type-grants.ts
 * becomes possible without taking the host's own control down with it. That
 * revocation is deliberately NOT part of this change: the button has to be
 * pointing here, in production, first.
 *
 * "Host" is `resolveMeetingAccess`'s host — the plan owner OR an accepted
 * collaborator on a webinar or class. Collaborators co-deliver those sessions,
 * so an owner-only test would leave a co-host unable to close a room they are
 * running. It is wider than the button's own `isHost`, which compares against a
 * single `custom.consultantUserId`; a collaborator sees no button and would
 * have to call this deliberately.
 *
 * `MeetingSession.endedAt` is deliberately not written here. The `call.ended`
 * webhook owns it, and it also sets the slot's completionStatus and the
 * session's actual duration — writing `endedAt` first would make that handler
 * treat the event as a duplicate and skip all of it.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  let meetingIdForLog: string | undefined;
  try {
    const guard = await guardMeetingRoute(params, "end");
    if (!guard.ok) return guard.response;
    const { userId, meetingId, access } = guard;
    meetingIdForLog = meetingId;

    // A participant is authorized to BE in this call and not to close it. The
    // distinction is the whole point of the route, so it gets its own refusal
    // rather than reusing the access one.
    if (access.role !== "host") {
      streamLogger.warn("Meeting end refused — caller is not the host", {
        userId,
        meetingId,
        role: access.role,
      });
      return NextResponse.json(
        {
          error: "Only the host can end this call for everyone.",
          reason: "not_host",
        },
        { status: 403 },
      );
    }

    await withStreamCircuitBreaker(() =>
      getStreamVideoClient()
        .video.call(STREAM_CALL_TYPE, toCallId(access.streamCallId))
        .end(),
    );

    streamLogger.info("Meeting ended by host", {
      userId,
      meetingId,
    });

    return NextResponse.json({ ended: true, callId: meetingId });
  } catch (error) {
    if (error instanceof StreamUnavailableError) {
      streamLogger.warn("Meeting end unavailable — Stream circuit open", {
        meetingId: meetingIdForLog,
      });
      return NextResponse.json(
        { error: "Video is temporarily unavailable. Please try again." },
        { status: 503 },
      );
    }

    reportSentryError(error, { subsystem: "stream", op: "meetings.end" });
    streamLogger.error("Failed to end meeting", error);
    return NextResponse.json(
      { error: "Could not end this meeting. Please try again." },
      { status: 500 },
    );
  }
}
