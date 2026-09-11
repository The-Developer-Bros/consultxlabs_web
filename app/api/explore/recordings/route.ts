/**
 * Public recordings library — marketplace listing API (#366).
 * GET /api/explore/recordings
 *
 * Anonymous-safe. Returns listing metadata only (no playback URLs); access to
 * the media itself is granted exclusively by the authenticated
 * /api/stream/recordings/[recordingId] route after entitlement checks.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listPublicRecordings } from "@/lib/data/recordings-explore";

const QuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(48).default(12),
  search: z.string().trim().max(120).optional(),
  tag: z.string().trim().max(30).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const parsed = QuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid query", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }

    const result = await listPublicRecordings(parsed.data);
    return NextResponse.json(result, {
      headers: {
        // Listing data is ISR-grade; let the CDN cache it briefly.
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch (error) {
    console.error("Error listing public recordings:", error);
    return NextResponse.json(
      { error: "Failed to load recordings" },
      { status: 500 },
    );
  }
}
