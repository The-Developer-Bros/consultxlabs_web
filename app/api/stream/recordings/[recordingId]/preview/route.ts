/**
 * Recording Listing Preview Assets (#366)
 * POST   /api/stream/recordings/[recordingId]/preview — upload clip and/or thumbnail
 * DELETE /api/stream/recordings/[recordingId]/preview — remove preview assets
 *
 * Preview assets are PUBLIC marketing material for explore cards (ISR-cached,
 * anonymous traffic) — they live in the public `recordings-previews` bucket,
 * never in the private recordings bucket.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { guardOwnedListingRecording } from "@/lib/stream/recording-listing-access";
import {
  uploadRecordingPreviewAsset,
  deleteRecordingPreviewAssets,
} from "@/lib/supabase";

type RouteParams = { params: Promise<{ recordingId: string }> };

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { recordingId } = await params;
    const guard = await guardOwnedListingRecording(recordingId);
    if (!guard.ok) return guard.response;


    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        { error: "Invalid multipart body", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }

    const clip = formData.get("clip");
    const thumb = formData.get("thumb");
    if (!(clip instanceof File && clip.size > 0) && !(thumb instanceof File && thumb.size > 0)) {
      return NextResponse.json(
        {
          error: "Provide a `clip` (MP4/WebM ≤50MB) and/or `thumb` (image ≤5MB)",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }

    // Typed payload (no Record<string,…> escape hatch) and PARTIAL-SUCCESS
    // persistence: if the thumbnail fails after the clip landed, the clip is
    // still committed before we 400 — otherwise it would sit orphaned in
    // storage with no DB pointer to clean it up later.
    const updates: {
      previewClipUrl?: string;
      previewClipStoragePath?: string;
      thumbnailUrl?: string;
    } = {};
    let partialError: string | null = null;

    if (clip instanceof File && clip.size > 0) {
      const result = await uploadRecordingPreviewAsset(recordingId, "clip", clip);
      if (result.success && result.url && result.storagePath) {
        updates.previewClipUrl = result.url;
        updates.previewClipStoragePath = result.storagePath;
      } else {
        return NextResponse.json(
          { error: result.error ?? "Preview upload failed", code: "UPLOAD_ERROR" },
          { status: 400 },
        );
      }
    }

    if (thumb instanceof File && thumb.size > 0) {
      const result = await uploadRecordingPreviewAsset(recordingId, "thumb", thumb);
      if (result.success && result.url && result.storagePath) {
        updates.thumbnailUrl = result.url;
      } else {
        partialError = result.error ?? "Thumbnail upload failed";
      }
    }

    if (Object.keys(updates).length > 0) {
      await prisma.recording.update({
        where: { id: recordingId },
        data: updates,
        select: { id: true },
      });
    }

    if (partialError) {
      return NextResponse.json(
        {
          error: partialError,
          code: "PARTIAL_UPLOAD",
          message:
            "Some assets uploaded successfully and were saved; retry the failed one.",
          persisted: Object.keys(updates),
        },
        { status: 400 },
      );
    }

    const updated = await prisma.recording.findUniqueOrThrow({
      where: { id: recordingId },
      select: { id: true, previewClipUrl: true, thumbnailUrl: true },
    });
    return NextResponse.json({ data: updated });
  } catch (error) {
    console.error("Error uploading recording preview:", error);
    return NextResponse.json(
      { error: "Failed to upload preview" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: RouteParams,
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { recordingId } = await params;
    const guard = await guardOwnedListingRecording(recordingId);
    if (!guard.ok) return guard.response;


    await deleteRecordingPreviewAssets(recordingId);
    const updated = await prisma.recording.update({
      where: { id: recordingId },
      data: {
        previewClipUrl: null,
        previewClipStoragePath: null,
        previewClipDuration: null,
        thumbnailUrl: null,
      },
      select: { id: true },
    });
    return NextResponse.json({ data: updated });
  } catch (error) {
    console.error("Error deleting recording previews:", error);
    return NextResponse.json(
      { error: "Failed to delete previews" },
      { status: 500 },
    );
  }
}
