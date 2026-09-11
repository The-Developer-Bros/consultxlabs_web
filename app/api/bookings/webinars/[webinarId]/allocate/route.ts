/**
 * Webinar Slot Allocation API Route
 *
 * Refactored to use unified SlotAllocationService
 * Reduced from 520 lines to ~100 lines
 *
 * VALIDATION LAYERS:
 * 1. Zod schema validation - Type-safe validation with automatic type inference
 * 2. SlotAllocationService - Validates business rules and executes allocation
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { SlotAllocationService } from "@/utils/slotAllocation/SlotAllocationService";
import { AllocationMode } from "@/utils/slotAllocation/types";
import {
  allocationRequestSchema,
  eventIdSchema,
} from "@/schemas/slotAllocation/validationSchemas";
import { ZodError } from "zod";
import {
  requireApiAuth,
  authorizeEventAccess,
  isEventConsultant,
} from "@/lib/auth-helpers";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  const startTime = Date.now();
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
      console.log(
        `[Webinar Allocation] Starting allocation for webinar: ${webinarId}`,
      );

      // Validate request body and get typed data
      const body = allocationRequestSchema.parse(await request.json());

      // Determine allocation mode
      let mode: AllocationMode;
      if (body.useRequestedSlots) {
        mode = "requested";
      } else if (body.isAuto) {
        mode = "auto";
      } else {
        mode = "manual";
      }

      console.log(
        `[Webinar Allocation] Mode: ${mode}, Slots: ${body.slots ? body.slots.length : "auto"}`,
      );

      const canOverride = await isEventConsultant(
        authResult.session,
        "webinar",
        webinarId,
      );

      // LAYER 2: Business Logic Validation & Allocation
      const result = await SlotAllocationService.allocate({
        eventType: "webinar",
        eventId: webinarId,
        mode,
        slots: body.slots,
        // #837 — client dedupe key; a double-submit with the same value returns
        // the first batch instead of allocating twice.
        idempotencyKey: request.headers.get("Idempotency-Key") ?? undefined,
        initialAllocation: body.initialAllocation,
        expectedTentativeSlotCount: body.expectedTentativeSlotCount,
        // Honoured only for the consultant (or ADMIN/STAFF): accepting a
        // time outside the published availability is the consultant's call,
        // not something a consultee may assert about someone else's schedule.
        override: body.override === true && canOverride,
        // #1206 — only the consultant (or a privileged caller) may decide to
        // schedule fewer sessions than the plan sold.
        allowPartial: body.allowPartial === true && canOverride,
        // #1206 — top up the sessions an earlier partial allocation left
        // unplaced instead of deleting the confirmed ones and re-planning.
        topUp: body.topUp === true && canOverride,
      });

      const duration = Date.now() - startTime;
      if (!result.success) {
        console.error(
          `[Webinar Allocation] Failed after ${duration}ms: ${result.error}`,
        );
        return NextResponse.json(
          {
            error: result.error,
            // Allocation-resilience audit gap #5 — the client needs the
            // structured code to render a cause-specific toast instead of
            // guessing from the raw message string.
            errorCode: result.errorCode,
            // #1206 — a SLOT_SHORTAGE the consultant could still act on: the
            // client offers "allocate N now, the rest later" instead of a
            // dead end.
            placeableSessions: result.placeableSessions,
            requiredSessions: result.requiredSessions,
            details: {
              webinarId,
              mode,
              slotsProvided: body.slots ? body.slots.length : 0,
              duration,
            },
          },
          { status: result.httpStatus ?? 500 },
        );
      }

      console.log(
        `[Webinar Allocation] Success after ${duration}ms. Created ${result.appointments?.length || 0} appointment(s)`,
      );
      if (result.warnings && result.warnings.length > 0) {
        console.warn(
          `[Webinar Allocation] Warnings: ${result.warnings.join("; ")}`,
        );
      }

      return NextResponse.json({
        data: result.appointments,
        warnings: result.warnings,
        // #1206 — derived, never stored: how much of the plan now has times.
        partial: result.partial,
        placedSessions: result.placedSessions,
        requiredSessions: result.requiredSessions,
        unplacedSessions: result.unplacedSessions,
        // #1206 — a top-up that wrote nothing. Lets the caller tell "already
        // complete / still no room" from "sessions were added".
        noChange: result.noChange,
      });
    } catch (validationError) {
      const duration = Date.now() - startTime;
      // Zod validation errors - return 400 Bad Request
      if (validationError instanceof ZodError) {
        const errorMessage = validationError.errors
          .map((err) => `${err.path.join(".")}: ${err.message}`)
          .join("; ");

        console.error(
          `[Webinar Allocation] Validation failed after ${duration}ms:`,
          JSON.stringify(validationError.errors, null, 2),
        );

        return NextResponse.json(
          {
            error: errorMessage,
            details: validationError.errors,
            webinarId,
          },
          { status: 400 },
        );
      }
      throw validationError; // Re-throw non-validation errors
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    // Catch-all for unexpected errors (database errors, network issues, etc.)
    console.error(`[Webinar Allocation] Error after ${duration}ms:`, error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "An error occurred during slot allocation",
        duration,
      },
      { status: 500 },
    );
  }
}
