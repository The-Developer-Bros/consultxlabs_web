/**
 * Subscription Slot Validation API Route
 *
 * Refactored to use unified SlotValidationService + SubscriptionValidationService
 * Reduced from 240 lines to ~100 lines
 *
 * VALIDATION LAYERS:
 * 1. Zod schema validation - Type-safe validation with automatic type inference
 * 2. SlotValidationService - Validates business rules (conflicts, availability, etc.)
 * 3. SubscriptionValidationService - Validates subscription-specific rules (weekly limits, etc.)
 */

import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { SlotValidationService } from "@/utils/slotAllocation/SlotValidationService";
import { SubscriptionValidationService } from "@/utils/subscriptionValidation";
import {
  validationRequestSchema,
  eventIdSchema,
} from "@/schemas/slotAllocation/validationSchemas";
import { ZodError } from "zod";
import type { SlotConflictResult } from "@/utils/slotAllocation/types";
import { requireApiAuth, authorizeEventAccess } from "@/lib/auth-helpers";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";

interface ValidationResult extends SlotConflictResult {
  subscriptionValidation?: {
    isValid: boolean;
    errors: string[];
    warnings: string[];
    weeklyInfo: Array<{
      weekStart: Date;
      weekEnd: Date;
      existingCalls: number;
      maxCalls: number;
      canScheduleMore: boolean;
      availableSlots: number;
    }>;
    totalCallsScheduled: number;
    maxTotalCalls: number;
    subscriptionPeriod: {
      start: Date;
      end: Date;
    };
  };
}

const subscriptionInclude = {
  subscriptionPlan: {
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
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;

    const { subscriptionId } = await params;

    const authzError = await authorizeEventAccess(
      authResult.session,
      "subscription",
      subscriptionId,
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
      // Validate subscription ID from URL params
      eventIdSchema.parse(subscriptionId);

      // Validate request body and get typed data
      const body = validationRequestSchema.parse(await request.json());

      // Fetch subscription with necessary relations
      const subscription = await prisma.subscription.findUnique({
        where: { id: subscriptionId },
        include: subscriptionInclude,
      });

      if (!subscription) {
        return NextResponse.json(
          { error: "Subscription not found" },
          { status: 404 },
        );
      }

      const { subscriptionPlan } = subscription;
      const { consultantProfile } = subscriptionPlan;

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
        "subscription",
        subscriptionId,
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
          durationInMonths: subscriptionPlan.durationInMonths,
          sessionsPerWeek: subscriptionPlan.sessionsPerWeek,
          sessionDurationInHours: subscriptionPlan.sessionDurationInHours,
          schedulingPeriodStartsAt: subscription.schedulingPeriodStartsAt,
          schedulingPeriodEndsAt: subscription.schedulingPeriodEndsAt,
        },
      );

      // LAYER 3: Subscription-Specific Validation (weekly limits, total calls, etc.)
      const subscriptionValidationService = new SubscriptionValidationService(
        prisma,
      );
      const subscriptionValidation =
        await subscriptionValidationService.validateSubscriptionSlots(
          subscriptionId,
          body.slots,
        );

      // Build response
      const result: ValidationResult = {
        conflicts: [],
        outsideAvailability: [],
        validSlots: validationResult.isValid ? body.slots : [],
        subscriptionValidation,
      };

      // Categorize errors by prefix instead of brittle regex
      if (!validationResult.isValid) {
        for (const error of validationResult.errors) {
          if (error.startsWith("[CONFLICT]")) {
            const message = error.replace("[CONFLICT] ", "");
            const slotMatch = message.match(
              /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/,
            );
            if (slotMatch) {
              result.conflicts.push({
                slot: slotMatch[1],
                existingAppointment: {
                  type: message.includes("subscription")
                    ? "Subscription"
                    : "Consultation",
                  with: "Another user",
                  time: new Date(slotMatch[1]).toLocaleString(),
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

        // Filter valid slots
        result.validSlots = body.slots.filter((slot) => {
          return (
            !result.conflicts.some((c) => c.slot === slot) &&
            !result.outsideAvailability.some((o) => o.slot === slot)
          );
        });
      }

      // If subscription validation fails, no slots are valid
      if (!subscriptionValidation.isValid) {
        result.validSlots = [];
      }

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
    console.error("Validation error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to validate slots",
      },
      { status: 500 },
    );
  }
}
