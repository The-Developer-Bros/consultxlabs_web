import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { resolveMeetingAccess } from "@/lib/meetings/access";
import { reportSentryError } from "@/lib/observability/report";

/**
 * GET /api/meetings/[meetingId]/validate-access
 *
 * Read-only "may I?" probe, used by surfaces that need to show or hide a Join
 * affordance before the user commits.
 *
 * It is NOT the gate. #1134 P0-1 — this route returning `hasAccess: true` never
 * granted anything; the page merely drew a different component, while Stream
 * happily admitted anyone holding an app token. `POST /api/meetings/[id]/join`
 * is the gate: it shares the same resolver and is the only thing that grants
 * call membership. Keep this endpoint free of side effects so the two can never
 * drift into two different answers.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });

    if (!session?.user?.id) {
      return NextResponse.json(
        { hasAccess: false, role: null, message: "Authentication required" },
        { status: 401 },
      );
    }

    const { meetingId } = await params;

    if (!meetingId) {
      return NextResponse.json(
        { hasAccess: false, role: null, message: "Meeting ID is required" },
        { status: 400 },
      );
    }

    const access = await resolveMeetingAccess(meetingId, session.user.id);

    return NextResponse.json(
      {
        hasAccess: access.hasAccess,
        role: access.role,
        message: access.message,
        reason: access.reason,
      },
      { status: access.reason === "not_found" ? 404 : 200 },
    );
  } catch (error) {
    reportSentryError(error, {
      subsystem: "meetings",
      op: "validateMeetingAccess",
    });
    return NextResponse.json(
      { hasAccess: false, role: null, message: "Failed to validate access" },
      { status: 500 },
    );
  }
}
