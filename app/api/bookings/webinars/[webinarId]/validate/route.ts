/**
 * Webinar Slot Validation API Route
 *
 * Refactored to use unified SlotValidationService
 * Reduced from 302 lines to ~90 lines
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

const webinarInclude = {
  webinarPlan: {
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
} as const;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;

    const { webinarId } = await params;

    const authzError = await authorizeEventAccess(
      authResult.session,
      "webinar",
      webinarId,
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
      // Validate webinar ID from URL params
      eventIdSchema.parse(webinarId);

      // Validate request body and get typed data
      const body = validationRequestSchema.parse(await request.json());

      // Fetch webinar with necessary relations
      const webinar = await prisma.webinar.findUnique({
        where: { id: webinarId },
        include: webinarInclude,
      });

      if (!webinar) {
        return NextResponse.json(
          { error: "Webinar not found" },
          { status: 404 },
        );
      }

      const { webinarPlan } = webinar;
      const { consultantProfile } = webinarPlan;

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
      const validationResult = await validationService.validate(
        "webinar",
        webinarId,
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
          durationInHours: webinarPlan.durationInHours || 1,
        },
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
                  : message.includes("webinar")
                    ? "Webinar"
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
          }
        }
        // [VALIDATION] errors don't need slot-level parsing
      }

      // Valid slots are those not in conflicts or outside availability
      result.validSlots = body.slots.filter((slot) => {
        return (
          !result.conflicts.some((c) => c.slot === slot) &&
          !result.outsideAvailability.some((o) => o.slot === slot)
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
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    console.error("Webinar validation error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to validate webinar slot",
      },
      { status: 500 },
    );
  }
}
