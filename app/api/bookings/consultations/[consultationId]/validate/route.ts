/**
 * Consultation Slot Validation API Route
 *
 * Refactored to use unified SlotValidationService
 * Reduced from 200 lines to ~90 lines
 *
 * VALIDATION LAYERS:
 * 1. Zod schema validation - Type-safe validation with automatic type inference
 * 2. SlotValidationService - Validates business rules (conflicts, availability, etc.)
 */

import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { SlotValidationService } from "@/utils/slotAllocation/SlotValidationService";
import {
  validationRequestSchema,
  eventIdSchema,
} from "@/schemas/slotAllocation/validationSchemas";
import { ZodError } from "zod";
import type { SlotConflictResult } from "@/utils/slotAllocation/types";
import { requireApiAuth, authorizeEventAccess } from "@/lib/auth-helpers";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";

const consultationInclude = {
  consultationPlan: {
    include: {
      consultantProfile: {
        select: {
          user: true,
          scheduleType: true,
          slotsOfAvailabilityWeekly: true,
          slotsOfAvailabilityCustom: true,
        },
      },
    },
  },
  requestedBy: {
    include: {
      user: true,
    },
  },
} as const;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ consultationId: string }> },
) {
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;

    const { consultationId } = await params;

    const authzError = await authorizeEventAccess(
      authResult.session,
      "consultation",
      consultationId,
    );
    if (authzError) return authzError;

    // #831 — event mutations previously had no limiter
    const rl = await applyRateLimit(
      eventMutationLimiter,
      authResult.session.user.id,
    );
    if (rl) return rl;

    // LAYER 1: Zod Schema Validation (type-safe, automatic type inference)
    try {
      // Validate consultation ID from URL params
      eventIdSchema.parse(consultationId);

      // Validate request body and get typed data
      const body = validationRequestSchema.parse(await request.json());

      // Fetch consultation with necessary relations
      const consultation = await prisma.consultation.findUnique({
        where: { id: consultationId },
        include: consultationInclude,
      });

      if (!consultation) {
        return NextResponse.json(
          { error: "Consultation not found" },
          { status: 404 },
        );
      }

      const { consultationPlan, requestedBy: _requestedBy } = consultation;
      const { consultantProfile } = consultationPlan;

      if (!consultantProfile) {
        return NextResponse.json(
          { error: "Consultant profile not found" },
          { status: 400 },
        );
      }

      // Convert slots to Date objects
      const slotDates = body.slots.map((slot) => new Date(slot));

      // LAYER 2: Business Logic Validation (conflicts, availability, consecutive slots, etc.)
      const validationService = new SlotValidationService(prisma);

      // Exclude this consultation's own tentative appointments from conflict
      // detection. During re-allocation (e.g. "Use Requested Times"), the old
      // tentative slots still exist and would otherwise be reported as conflicts.
      const tentativeAppointments = await prisma.appointment.findMany({
        where: {
          consultationId,
          slotsOfAppointment: { some: { isTentative: true } },
        },
        select: { id: true },
      });
      const excludeIds = tentativeAppointments.map((a) => a.id);

      // The allocator counts the CONSULTEE's bookings with any consultant as
      // conflicts, so a preflight that omitted them reported "no conflicts" for
      // times the very next call would reject. The dialog renders its verdict
      // from this response, so the omission made that verdict unsound.
      const consulteeUserId = (
        await prisma.consultation.findUnique({
          where: { id: consultationId },
          select: { requestedBy: { select: { user: { select: { id: true } } } } },
        })
      )?.requestedBy?.user?.id;

      const validationResult = await validationService.validate(
        "consultation",
        consultationId,
        slotDates,
        {
          userId: consultantProfile.user.id,
          scheduleType: consultantProfile.scheduleType,
          slotsOfAvailabilityWeekly:
            consultantProfile.slotsOfAvailabilityWeekly,
          slotsOfAvailabilityCustom:
            consultantProfile.slotsOfAvailabilityCustom,
          timezone: consultantProfile.user.timezone || undefined,
        },
        {
          durationInHours: consultationPlan.durationInHours,
        },
        excludeIds,
        { consulteeUserId },
      );

      // If validation passed, all slots are valid
      if (validationResult.isValid) {
        return NextResponse.json({
          data: {
            conflicts: [],
            outsideAvailability: [],
            validSlots: body.slots,
          },
        });
      }

      // Categorize errors by prefix instead of brittle regex
      const result: SlotConflictResult = {
        conflicts: [],
        outsideAvailability: [],
        validSlots: [],
      };

      for (const error of validationResult.errors) {
        if (error.startsWith("[CONFLICT]")) {
          const message = error.replace("[CONFLICT] ", "");
          // Extract slot time from error message
          const slotMatch = message.match(
            /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/,
          );
          if (slotMatch) {
            const slot = slotMatch[1];
            result.conflicts.push({
              slot,
              existingAppointment: {
                type: message.includes("subscription")
                  ? "Subscription"
                  : "Consultation",
                with: "Another user",
                time: new Date(slot).toLocaleString(),
              },
            });
          }
        } else if (error.startsWith("[OUTSIDE_AVAILABILITY]")) {
          const message = error.replace("[OUTSIDE_AVAILABILITY] ", "");
          const slotMatch = message.match(
            /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/,
          );
          if (slotMatch) {
            result.outsideAvailability.push({ slot: slotMatch[1] });
          } else {
            // Error doesn't contain specific ISO timestamps (e.g. weekly schedule
            // availability check returns "Saturday at 15:00 UTC" format).
            // Mark ALL provided slots as outside availability.
            for (const bodySlot of body.slots) {
              const normalized = new Date(bodySlot).toISOString().slice(0, 19);
              if (
                !result.outsideAvailability.some((o) => o.slot === normalized)
              ) {
                result.outsideAvailability.push({ slot: normalized });
              }
            }
          }
        }
        // [VALIDATION] errors don't need slot-level parsing
      }

      // Valid slots are those not in conflicts or outside availability.
      // FIX: Normalize both sides to seconds-precision UTC ISO (strip .000Z suffix)
      // so "2026-02-23T04:30:00.000Z" and "2026-02-23T04:30:00" compare equal.
      result.validSlots = body.slots.filter((bodySlot) => {
        const bodySlotSeconds = new Date(bodySlot).toISOString().slice(0, 19);
        return (
          !result.conflicts.some((c) => c.slot === bodySlotSeconds) &&
          !result.outsideAvailability.some((o) => o.slot === bodySlotSeconds)
        );
      });

      return NextResponse.json({ data: result });
    } catch (validationError) {
      // Zod validation errors - return 400 Bad Request
      if (validationError instanceof ZodError) {
        const errorMessage = validationError.errors
          .map((err) => `${err.path.join(".")}: ${err.message}`)
          .join("; ");

        return NextResponse.json({ error: errorMessage }, { status: 400 });
      }
      throw validationError; // Re-throw non-validation errors
    }
  } catch (error) {
    // Catch-all for unexpected errors (database errors, network issues, etc.)
    console.error("Validation error:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to validate slots",
      },
      { status: 500 },
    );
  }
}
