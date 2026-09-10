/**
 * GET /api/staff/appointments/[appointmentId]/timeline — the booking audit
 * trail for one appointment (#1319 PR 8, #448).
 *
 * Thin shell over `getBookingTimeline`, mirroring the sibling
 * `/api/staff/appointments` route exactly: `requirePrivilegedAuth` is the gate,
 * and passing it is what earns the `all` scope, so no membership check widens
 * it (#674 defect 13). ADR 20 keeps this off the organization surfaces — an org
 * role has no per-session drill-in to hang a timeline off.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { getBookingTimeline } from "@/lib/data/booking-history";
import { applyRateLimit, participantReadLimiter } from "@/lib/rate-limit";

interface RouteParams {
  params: Promise<{ appointmentId: string }>;
}

// Appointment.id is `@default(uuid())`, so anything else is a broken link
// rather than a miss — reject it before it reaches the database.
const TimelineParams = z.object({ appointmentId: z.string().uuid() });

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const parsed = TimelineParams.safeParse(await params);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid appointment id" },
        { status: 400 },
      );
    }

    // No staff route has its own bucket, and this one is a per-appointment read
    // an operator opens by hand. `participantReadLimiter` is the platform's
    // 30/min-per-user read profile; the route slug keeps it from sharing a
    // counter with the participant lists, as `applyRateLimit` documents.
    const limited = await applyRateLimit(
      participantReadLimiter,
      `staff-timeline:${auth.session.user.id}`,
    );
    if (limited) return limited;

    const timeline = await getBookingTimeline(parsed.data.appointmentId, {
      kind: "all",
    });
    if (!timeline) {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    return NextResponse.json(timeline);
  } catch (error) {
    console.error("Error fetching appointment timeline:", error);
    return NextResponse.json(
      { error: "Failed to fetch appointment timeline" },
      { status: 500 },
    );
  }
}
