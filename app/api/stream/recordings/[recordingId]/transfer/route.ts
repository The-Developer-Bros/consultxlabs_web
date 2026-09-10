/**
 * Recording Transfer API Route
 * POST /api/stream/recordings/[recordingId]/transfer
 *
 * Manually triggers transfer of a recording from Stream S3 to Supabase.
 * Only consultants who own the recording can trigger transfer.
 */

import { NextRequest, NextResponse } from "next/server";
import { RecordingTransferService } from "@/lib/stream/recording-transfer-service";
import { getRecordingOwnershipInfo } from "@/lib/stream/recording-utils";
import {
  appointmentStoragePolicySelect,
  resolveAppointmentStoragePolicy,
} from "@/lib/stream/recording-listing-access";
import prisma from "@/lib/prisma";

import { getSession } from "@/lib/auth-server";
type RouteParams = {
  params: Promise<{
    recordingId: string;
  }>;
};

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Capability, not UserRole (#org-appts): owning a consultantProfile is what
    // matters (an org EXPERT counts); the per-appointment ownership check below
    // is the real authz.
    if (!session.user.consultantProfileId) {
      return NextResponse.json(
        { error: "Only consultants can transfer recordings" },
        { status: 403 },
      );
    }

    const { recordingId } = await params;

    // Get recording with ownership info
    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      include: {
        meetingSession: {
          include: {
            slotOfAppointment: {
              include: {
                appointment: { select: appointmentStoragePolicySelect },
              },
            },
          },
        },
      },
    });

    if (!recording) {
      return NextResponse.json(
        { error: "Recording not found" },
        { status: 404 },
      );
    }

    // Look up consultant profile for the logged-in user
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });

    // Verify ownership using helper function
    const { isOwner } = getRecordingOwnershipInfo(
      recording,
      consultantProfile?.id,
    );

    if (!isOwner) {
      return NextResponse.json(
        { error: "Not authorized to transfer this recording" },
        { status: 403 },
      );
    }

    // Check if recording is already transferred
    if (recording.storageType === "PLATFORM") {
      return NextResponse.json(
        { error: "Recording is already transferred to permanent storage" },
        { status: 400 },
      );
    }

    // Check if recording is in a transferable state
    if (recording.status !== "READY") {
      return NextResponse.json(
        {
          error: `Recording cannot be transferred in ${recording.status} state`,
        },
        { status: 400 },
      );
    }

    // Policy enforcement — manual transfer is a PREMIUM capability. The plan
    // that produced this session decides; a STREAM_ONLY plan must not be able
    // to mint permanent storage (and its costs) by hitting this endpoint.
    const apt = recording.meetingSession.slotOfAppointment.appointment;
    const { policy: storagePolicy } = resolveAppointmentStoragePolicy(apt);

    if (storagePolicy !== "PERMANENT") {
      return NextResponse.json(
        {
          error:
            "Permanent storage is available on plans with premium recording. Stream keeps this recording for 14 days — download it or upgrade your plan to keep it permanently.",
          code: "UPGRADE_REQUIRED",
        },
        { status: 403 },
      );
    }

    // Start transfer
    const result =
      await RecordingTransferService.transferRecordingToSupabase(recordingId);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "Transfer failed" },
        { status: 500 },
      );
    }

    // Get updated recording
    const updatedRecording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: {
        id: true,
        status: true,
        storageType: true,
        storageUrl: true,
        transferredAt: true,
      },
    });

    return NextResponse.json({
      success: true,
      message: "Recording transferred successfully",
      recording: updatedRecording,
    });
  } catch (error) {
    console.error("Error transferring recording:", error);
    return NextResponse.json(
      { error: "Failed to transfer recording" },
      { status: 500 },
    );
  }
}
