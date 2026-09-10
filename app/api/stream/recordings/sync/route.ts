/**
 * Sync Recordings API Route
 * POST /api/stream/recordings/sync
 *
 * Syncs recordings from Stream API for a user's sessions.
 * Creates Recording records for any recordings not already in DB.
 * Consultants sync their own sessions, consultees sync their enrolled sessions.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { RecordingService } from "@/lib/stream/recording-service";
import { applyRateLimit, streamRecordingSyncLimiter } from "@/lib/rate-limit";

import { getSession } from "@/lib/auth-server";
export async function POST(_req: NextRequest) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // #1270 — keyed on the user, after auth and before any Stream work. This
    // route is one cheap POST that fans out a `listRecordings` call to Stream
    // for every session the caller touches, so it was an unbounded, billable
    // amplifier for any authenticated account. The edge `stream: api` rule
    // covers the path but is IP-keyed at 60/min, which neither identifies the
    // caller nor reflects what this endpoint costs to serve.
    const limited = await applyRateLimit(
      streamRecordingSyncLimiter,
      `recordings-sync:${session.user.id}`,
    );
    if (limited) return limited;

    type SyncResult = {
      synced: number;
      recordings: {
        id: string;
        title: string;
        durationInMinutes: number;
        recordedAt: Date;
        status: string;
      }[];
    };

    // Capability, not UserRole (#org-appts): an org EXPERT whose top-level role is CONSULTEE still owns recordings they delivered.
    // Sync whichever identities the user actually owns — a dual-identity user
    // syncs both provider and attendee sessions.
    const results: SyncResult[] = [];

    if (session.user.consultantProfileId) {
      // Provider syncs their own sessions
      results.push(
        await RecordingService.syncRecordingsForConsultant(
          session.user.consultantProfileId,
        ),
      );
    }

    if (session.user.consulteeProfileId) {
      // Attendee syncs their enrolled sessions
      results.push(
        await RecordingService.syncRecordingsForConsultee(
          session.user.consulteeProfileId,
          session.user.id,
        ),
      );
    }

    if (results.length === 0) {
      return NextResponse.json(
        { error: "No consultant or consultee profile found" },
        { status: 400 },
      );
    }

    const recordings = results.flatMap((r) => r.recordings);

    return NextResponse.json({
      success: true,
      synced: results.reduce((sum, r) => sum + r.synced, 0),
      recordings: recordings.map((r) => ({
        id: r.id,
        title: r.title,
        durationInMinutes: r.durationInMinutes,
        recordedAt: r.recordedAt,
        status: r.status,
      })),
    });
  } catch (error) {
    console.error("Error syncing recordings:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });

    return NextResponse.json(
      { error: "Failed to sync recordings" },
      { status: 500 },
    );
  }
}
