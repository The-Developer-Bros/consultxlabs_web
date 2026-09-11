import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { AppointmentStatus } from "@prisma/client";
import {
  lockSlotBooking,
  unlockSlotBooking,
  lockConsulteeBooking,
  unlockConsulteeBooking,
  BookingLockUnavailableError,
  LockContentionError,
} from "@/utils/appointmentlock";
import { SlotLockError } from "@/utils/errors/SlotLockError";
import { SlotValidationService } from "@/utils/slotAllocation/SlotValidationService";
import { notifyNewBookingRequest } from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { scopedHref } from "@/lib/novu/resolve-href";
import { appendCreationHistory } from "@/lib/booking/transitions";
import { RequestForApprovalSchema } from "@/schemas/slots";
import { requestApprovalLimiter, applyRateLimit } from "@/lib/rate-limit";
import { ensureConsulteeProfile } from "@/lib/profiles/ensure-consultee-profile";
import {
  MAX_ACTIVE_REQUESTS_PER_USER,
  countActiveConsultationRequests,
} from "@/lib/booking/request-caps";

import { getSession } from "@/lib/auth-server";
import * as Sentry from "@sentry/nextjs";
export async function POST(req: NextRequest) {
  try {
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    // Rate limit: 10 approval requests per hour per user
    const rl = await applyRateLimit(requestApprovalLimiter, session.user.id);
    if (rl) return rl;

    const body = await req.json();
    const parseResult = RequestForApprovalSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parseResult.error.issues },
        { status: 400 },
      );
    }
    const {
      consultantProfileId,
      startsAt,
      endsAt,
      slotOfAvailabilityWeeklyId,
      slotOfAvailabilityCustomId,
      consultationPlanId,
      organizationId,
    } = parseResult.data;

    // #1166 ORG-9 — org sponsorship was silently dropped by the approval flow:
    // the request carried no org, so the approved booking billed the member's
    // personal card with no wallet debit, seat consumption, or attribution.
    // The request now carries it, stamped onto the Appointment below; the
    // approval pay-link and Payment row inherit it from there.
    if (organizationId) {
      const [org, membership] = await Promise.all([
        prisma.organization.findUnique({
          where: { id: organizationId },
          select: { canSponsor: true, status: true },
        }),
        prisma.membership.findUnique({
          where: {
            userId_organizationId: {
              userId: session.user.id,
              organizationId,
            },
          },
          select: { status: true },
        }),
      ]);
      // Same gate the checkout path applies: PENDING_VERIFICATION orgs may
      // still transact, anything else (suspended/inactive) may not. Without
      // it a suspended org rides the Appointment and then the Payment row,
      // and nothing re-checks status downstream.
      const orgTransactable =
        org?.status === "ACTIVE" || org?.status === "PENDING_VERIFICATION";
      if (
        !org?.canSponsor ||
        !orgTransactable ||
        membership?.status !== "ACTIVE"
      ) {
        return NextResponse.json(
          {
            error:
              "This organization cannot sponsor your booking (it is not a sponsor org, it is not in good standing, or you are not an active member).",
          },
          { status: 403 },
        );
      }
    }

    const startTime = new Date(startsAt);
    const endTime = new Date(endsAt);

    // Lazy-create ConsulteeProfile on first consumer action — org-workspace
    // operators and consultants who book approvals will otherwise 404 here.
    await ensureConsulteeProfile(prisma, session.user.id);
    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { userId: session.user.id },
      include: { user: true },
    });

    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    // Verify the consultation plan exists and belongs to the consultant
    const consultationPlan = await prisma.consultationPlan.findFirst({
      where: {
        id: consultationPlanId,
        consultantProfileId: consultantProfileId,
      },
      include: {
        consultantProfile: {
          include: {
            user: true,
          },
        },
      },
    });

    if (!consultationPlan) {
      return NextResponse.json(
        { error: "Consultation plan not found" },
        { status: 404 },
      );
    }

    // Create request notes with availability slot information
    const requestNotes =
      `Request for approval - Slot: ${startTime.toISOString()} to ${endTime.toISOString()}. ` +
      `Availability slot: ${slotOfAvailabilityWeeklyId ? `Weekly ID: ${slotOfAvailabilityWeeklyId}` : `Custom ID: ${slotOfAvailabilityCustomId}`}`;

    // DISTRIBUTED LOCKS: serialize on the CONSULTEE first, then the slot
    // atoms. Order matters: direct checkout takes consultee → slot atoms
    // (lib/payments/operations/checkout.ts), so this route must use the same
    // order — the reverse would let a checkout holding the consultee lock
    // wait on atoms this route holds while it waits on the consultee lock
    // (classic ABBA). The consultee arm is the piece the audit flagged (B8a):
    // without it the same user could race this route against their own
    // checkout on a DIFFERENT consultant and double-book themselves — the
    // GiST guard is consultant-keyed and cannot see it.
    let consulteeLock: Awaited<ReturnType<typeof lockConsulteeBooking>> | null =
      null;
    let lock;

    try {
      consulteeLock = await lockConsulteeBooking(session.user.id);

      // Anti-scalper cap (booking-journey audit B1): every PENDING request
      // holds a tentative slot that blocks the consultant's calendar. The
      // count runs INSIDE the consultee lock — outside it, two concurrent
      // submits both read n<3 and both insert, landing at 4+ active holds
      // (CodeRabbit triage on the TOCTOU).
      const activeRequests = await countActiveConsultationRequests(
        prisma,
        consulteeProfile.id,
      );
      if (activeRequests >= MAX_ACTIVE_REQUESTS_PER_USER) {
        return NextResponse.json(
          {
            error:
              `You already have ${activeRequests} requests awaiting approval ` +
              `(limit ${MAX_ACTIVE_REQUESTS_PER_USER}). Wait for a consultant ` +
              `to respond, or withdraw an existing request from your dashboard.`,
          },
          { status: 429 },
        );
      }

      try {
        // ACQUIRE LOCK for the whole requested interval (#1169 PR 1 — one key
        // per 30-min atom, so overlapping requests with different starts collide)
        // Use default 60s TTL (15s was too short for slow database operations)
        lock = await lockSlotBooking(consultantProfileId, startsAt, endsAt);

        console.log(
          JSON.stringify({
            event: "slot_booking_lock_acquired",
            consultant: consultantProfileId,
            slot: startsAt,
            user: session.user.id,
            timestamp: new Date().toISOString(),
          }),
        );

        // Generate 30-minute slot chunks from startTime to endTime.
        // SlotOfAppointment records are always 30 minutes each — consistent with
        // manual and auto allocation paths in SlotAllocationService.
        const SLOT_DURATION_MS = 30 * 60 * 1000;
        const slotChunkStarts: Date[] = [];
        let current = new Date(startTime);
        while (current < endTime) {
          slotChunkStarts.push(new Date(current));
          current = new Date(current.getTime() + SLOT_DURATION_MS);
        }
        if (slotChunkStarts.length === 0) {
          return NextResponse.json(
            { error: "Invalid slot: start time must be before end time" },
            { status: 400 },
          );
        }

        // RE-VALIDATE inside lock: Ensure ALL 30-min chunks are still available
        // This is the critical missing piece - prevents double-booking even after lock
        const validationService = new SlotValidationService(prisma);
        const validation = await validationService.checkSlotAvailability(
          slotChunkStarts,
          consultationPlan.consultantProfile.user.id,
        );

        if (!validation.isValid) {
          console.log(
            JSON.stringify({
              event: "slot_booking_validation_failed",
              consultant: consultantProfileId,
              slot: startsAt,
              user: session.user.id,
              errors: validation.errors,
              timestamp: new Date().toISOString(),
            }),
          );

          return NextResponse.json(
            {
              error: "Slot no longer available",
              details: validation.errors,
            },
            { status: 409 },
          );
        }

        console.log(
          JSON.stringify({
            event: "slot_booking_validation_passed",
            consultant: consultantProfileId,
            slot: startsAt,
            user: session.user.id,
            timestamp: new Date().toISOString(),
          }),
        );

        // CRITICAL SECTION: Create consultation (protected by lock AND validated)
        // Create one SlotOfAppointment per 30-min chunk — consistent with
        // SlotAllocationService which also uses 30-min granularity.
        const slotChunksToCreate = slotChunkStarts.map((chunkStart) => ({
          startsAt: chunkStart,
          endsAt: new Date(chunkStart.getTime() + SLOT_DURATION_MS),
          isTentative: true, // Mark as tentative since it's pending approval
          // #440 — the overlap-guard column must be set at CREATE time even on
          // tentative rows: approval/webhook confirm flips isTentative via
          // updateMany, so whatever is on the row rides into confirmed state.
          consultantProfileId,
          user: {
            connect: [
              { id: session.user.id }, // Consultee
              { id: consultationPlan.consultantProfile.user.id }, // Consultant
            ],
          },
        }));

        // #1333 — the request and its opening timeline row commit together, so
        // a booking that exists is never one the staff timeline has nothing to
        // say about. The nested create was already atomic on its own; the
        // transaction is what extends that atomicity to the audit row. The
        // budget sits well inside the 60 s slot lock held above.
        const consultation = await prisma.$transaction(
          async (tx) => {
            const created = await tx.consultation.create({
              data: {
                consultationPlanId: consultationPlanId,
                requestedById: consulteeProfile.id,
                status: AppointmentStatus.PENDING,
                requestNotes: requestNotes,
                appointment: {
                  create: {
                    appointmentType: "CONSULTATION",
                    // #1166 ORG-9 — org attribution rides the appointment from
                    // the moment the request exists.
                    organizationId: organizationId ?? null,
                    slotsOfAppointment: {
                      create: slotChunksToCreate,
                    },
                  },
                },
              },
              include: {
                consultationPlan: {
                  include: {
                    consultantProfile: {
                      include: {
                        user: true,
                      },
                    },
                  },
                },
                requestedBy: {
                  include: {
                    user: true,
                  },
                },
                appointment: {
                  include: {
                    slotsOfAppointment: true,
                  },
                },
              },
            });
            await appendCreationHistory(
              tx,
              "CONSULTATION",
              created.id,
              AppointmentStatus.PENDING,
              {
                appointmentId: created.appointment?.id ?? null,
                actorUserId: session.user.id,
                organizationId: created.appointment?.organizationId ?? null,
              },
            );
            return created;
          },
          { maxWait: 10_000, timeout: 15_000 },
        );

        console.log(
          JSON.stringify({
            event: "slot_booking_success",
            consultationId: consultation.id,
            consultant: consultantProfileId,
            slot: startsAt,
            user: session.user.id,
            timestamp: new Date().toISOString(),
          }),
        );

        // Fire-and-forget: notify consultant of new booking request.
        //
        // ADR 23 — the link used to hardcode the personal Requests page even for
        // an org-hosted plan, where the request is not listed: the personal scope
        // pins organizationId: null. Single recipient with a known side, so this
        // resolves to a precise route rather than the /dashboard bounce.
        const requestOrgId = consultation.appointment?.organizationId ?? null;
        void notifyNewBookingRequest(
          consultation.consultationPlan.consultantProfile.user.id,
          {
            ...notificationScope(requestOrgId),
            consulteeName: consultation.requestedBy.user.name || "A consultee",
            planTitle: consultation.consultationPlan.title,
            appointmentType: "CONSULTATION",
            requestedDateTime: startTime.toISOString(),
            dashboardUrl: scopedHref({
              organizationId: requestOrgId,
              surface: "requests",
              personal: {
                kind: "consultant",
                profileId: consultation.consultationPlan.consultantProfile.id,
              },
            }),
          },
        );

        return NextResponse.json(
          {
            message: "Request for approval submitted successfully",
            data: consultation,
          },
          { status: 201 },
        );
      } catch (lockError) {
        console.error(
          JSON.stringify({
            event: "slot_booking_error",
            consultant: consultantProfileId,
            slot: startsAt,
            user: session.user.id,
            error:
              lockError instanceof Error ? lockError.message : "Unknown error",
            timestamp: new Date().toISOString(),
          }),
        );

        // #1169 PR 1 — Redis-down fails closed with a structured 503; without
        // this branch the outage fell through to the generic 500 below.
        if (lockError instanceof BookingLockUnavailableError) {
          return NextResponse.json(
            { error: lockError.message },
            { status: lockError.httpStatus },
          );
        }

        // Check if error is lock acquisition failure (type-safe)
        if (lockError instanceof SlotLockError) {
          return NextResponse.json(
            {
              error: lockError.message,
              retryAfter: lockError.retryAfterSeconds,
            },
            { status: 409 }, // 409 Conflict
          );
        }

        Sentry.captureException(
          lockError instanceof Error ? lockError : new Error(String(lockError)),
          { tags: { subsystem: "scheduling" } },
        );
        throw lockError; // Re-throw other errors for general error handler
      } finally {
        // ALWAYS release lock (even on error)
        if (lock) {
          await unlockSlotBooking(lock);
          console.log(
            JSON.stringify({
              event: "slot_booking_lock_released",
              consultant: consultantProfileId,
              slot: startsAt,
              user: session.user.id,
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }
    } finally {
      // Release the consultee arm last (reverse acquisition order).
      if (consulteeLock) {
        await unlockConsulteeBooking(consulteeLock);
      }
    }
  } catch (error) {
    // Consultee-lock failures surface here (the inner catch only wraps the
    // slot-atom section). Map them to the SAME structured responses the slot
    // arm uses — a raw 500 for "someone else is booking as you" reads as our
    // fault and hides the retry (CodeRabbit triage).
    if (error instanceof BookingLockUnavailableError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.httpStatus },
      );
    }
    if (
      error instanceof LockContentionError ||
      error instanceof SlotLockError
    ) {
      return NextResponse.json(
        {
          error:
            "Another booking request is in progress for your account. Please try again in a moment.",
          retryAfter: 30,
        },
        { status: 409 },
      );
    }

    console.error("Error creating approval request:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "scheduling" } },
    );
    return NextResponse.json(
      { error: "An error occurred while creating the approval request" },
      { status: 500 },
    );
  }
}
