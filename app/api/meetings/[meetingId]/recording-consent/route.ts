import { RecordingConsentDecision } from "@prisma/client";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { resolveMeetingAccess } from "@/lib/meetings/access";
import {
  getRecordingNotice,
  recordRecordingConsent,
} from "@/lib/stream/recording-consent";
import { reportSentryError } from "@/lib/observability/report";

/**
 * Per-session recording consent (#1134 P1-7).
 *
 * GET  — what notice, if any, this person must be shown before joining.
 * POST — record their decision.
 *
 * Both are gated by resolveMeetingAccess, the same resolver the join gate uses:
 * only someone actually on this appointment may read its notice or record a
 * decision about it. Without that, the endpoint would leak which meeting ids
 * exist and whether they are recorded.
 */

const bodySchema = z.object({
  decision: z.nativeEnum(RecordingConsentDecision),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const { meetingId } = await params;
    const access = await resolveMeetingAccess(meetingId, session.user.id);
    if (!access.hasAccess) {
      return NextResponse.json(
        { error: access.message },
        { status: access.reason === "not_found" ? 404 : 403 },
      );
    }


    const notice = await getRecordingNotice(
      access.meetingSessionId,
      session.user.id,
      access.appointment,
    );

    return NextResponse.json(notice);
  } catch (error) {
    reportSentryError(error, {
      subsystem: "stream",
      op: "recordingConsent.get",
    });
    return NextResponse.json(
      { error: "Could not load the recording notice" },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const { meetingId } = await params;
    const access = await resolveMeetingAccess(meetingId, session.user.id);
    if (!access.hasAccess) {
      return NextResponse.json(
        { error: access.message },
        { status: access.reason === "not_found" ? 404 : 403 },
      );
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "decision must be GRANTED or DECLINED" },
        { status: 400 },
      );
    }


    const appointment = access.appointment;
    const notice = await getRecordingNotice(
      access.meetingSessionId,
      session.user.id,
      appointment,
    );

    // Nothing to consent to. Recording is off for this plan, so accepting a
    // decision would write a record implying a choice was offered.
    if (!notice.required) {
      return NextResponse.json(
        { error: "Recording is not enabled for this session" },
        { status: 400 },
      );
    }

    // A group session's recording is the product, disclosed at purchase — the
    // only decision available is acknowledgement. Refusing means not attending
    // (and cancelling for a refund), not attending un-recorded, so DECLINED has
    // no meaning the system could honour.
    if (
      notice.regime === "ACKNOWLEDGE" &&
      parsed.data.decision === RecordingConsentDecision.DECLINED
    ) {
      return NextResponse.json(
        {
          error:
            "This session is recorded as part of what attendees receive. To opt out, cancel your booking for a refund.",
        },
        { status: 409 },
      );
    }

    // Records the decision; does NOT act on a recording already in progress.
    // `getRecordingBlock` gates the START of a recording, so a decline lands
    // before one begins in the ordinary lobby flow — but this is an upsert, and
    // a participant can switch to DECLINED after the host has started. See the
    // SCOPE note on `getRecordingBlock`: stopping a live recording on decline is
    // a product decision and is deliberately not done here.
    await recordRecordingConsent(
      access.meetingSessionId,
      session.user.id,
      parsed.data.decision,
    );

    return NextResponse.json({
      decision: parsed.data.decision,
      regime: notice.regime,
      noticeVersion: notice.noticeVersion,
    });
  } catch (error) {
    reportSentryError(error, {
      subsystem: "stream",
      op: "recordingConsent.post",
    });
    return NextResponse.json(
      { error: "Could not record your choice" },
      { status: 500 },
    );
  }
}
