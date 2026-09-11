import * as Sentry from "@sentry/nextjs";
import {
  TimeSlot,
  calculateRequiredSlots,
  validateSlotDistribution,
} from "./calendarUtils";
import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";
import { countSessionsForDay } from "./slotSelectionValidation";
import { isRecurringEventType } from "@/utils/slotAllocation/types";
import { AllocationService } from "./allocationService";

/**
 * Client-side pre-validation + submission for the manual and requested
 * allocation modes. Auto mode has no client engine: the hook submits
 * `isAuto: true` and the SERVER picks the slots (utils/slotAllocation/,
 * preference scoring per #1065). The old client auto-allocator that lived
 * here — strategies, scoring, week distribution — survived only as a test
 * oracle after #997 Phase 1 and is deleted (#997/#1132); the parity suite
 * now exercises the real validators instead.
 */

export interface AllocationOptions {
  eventType: "consultation" | "subscription" | "webinar" | "class";
  eventId: string;
  durationInMonths?: number;
  sessionsPerWeek?: number;
  sessionDurationInHours?: number;
  durationInHours?: number; // FIXED: Add durationInHours for consultations and webinars
  startDate?: Date; // Required for subscriptions and classes
  endDate?: Date; // Required for subscriptions and classes
  totalSessions?: number; // Authoritative session count from plan (overrides weeks × sessionsPerWeek)
  requestedSlots?: TimeSlot[];
  pastConfirmedSlotCount?: number; // For in-progress recurring events
  // Idempotency-Key for the allocate request; a double-submit replays the
  // original batch server-side instead of double-booking (#837).
  idempotencyKey?: string;
  // Reject with 409 if the event already has confirmed slots (multi-tab guard).
  initialAllocation?: boolean;
  /** #1012 — reschedule stale-tab precondition. */
  expectedTentativeSlotCount?: number;
  // Timezone defining the limit day/week buckets (ADR B9); defaults to
  // Asia/Kolkata in the shared helpers.
  schedulingTimezone?: string;
}

export interface AllocationResult {
  success: boolean;
  selectedSlots: TimeSlot[];
  error?: string;
  /** Structured code from the server (NO_AVAILABILITY, PERIOD_ENDED, etc.). */
  errorCode?: string;
  strategy?: string;
  /** HTTP status of a failed allocate call — 409 means "allocated elsewhere". */
  httpStatus?: number;
}

export class AllocationAlgorithms {
  /**
   * Manual allocation - uses the slots selected by the user
   * ENHANCED: Better validation and error handling
   */
  static async manualAllocate(
    selectedSlots: TimeSlot[],
    options: AllocationOptions,
  ): Promise<AllocationResult> {
    try {
      // VALIDATION: Check required slots count
      // Pass durationInHours for consultations/webinars, sessionDurationInHours for subscriptions/classes
      const rawRequired = calculateRequiredSlots(
        options.eventType,
        options.durationInMonths,
        options.sessionsPerWeek,
        options.durationInHours || options.sessionDurationInHours,
        options.startDate,
        options.endDate,
        options.totalSessions,
      );

      // For in-progress recurring events, subtract past confirmed slots
      const pastCount = options.pastConfirmedSlotCount || 0;
      const requiredSlots =
        isRecurringEventType(options.eventType) && pastCount > 0
          ? Math.max(0, rawRequired - pastCount)
          : rawRequired;

      if (selectedSlots.length !== requiredSlots) {
        return {
          success: false,
          selectedSlots: [],
          error: `Expected ${requiredSlots} slots but received ${selectedSlots.length}`,
        };
      }

      // VALIDATION: No past slots allowed
      const now = new Date();
      const pastSlots = selectedSlots.filter((slot) => slot.startTime < now);
      if (pastSlots.length > 0) {
        return {
          success: false,
          selectedSlots: [],
          error: "Cannot allocate slots in the past",
        };
      }

      // BUSINESS RULE: Webinar slots must be consecutive
      if (options.eventType === "webinar" && selectedSlots.length > 1) {
        const sortedSlots = [...selectedSlots].sort(
          (a, b) => a.startTime.getTime() - b.startTime.getTime(),
        );

        for (let i = 1; i < sortedSlots.length; i++) {
          const prevSlot = sortedSlots[i - 1];
          const currentSlot = sortedSlots[i];
          if (currentSlot.startTime.getTime() !== prevSlot.endTime.getTime()) {
            return {
              success: false,
              selectedSlots: [],
              error: "Webinar slots must be consecutive",
            };
          }
        }
      }

      // BUSINESS RULE: Subscription/Class distribution validation
      if (
        options.eventType === "subscription" ||
        options.eventType === "class"
      ) {
        if (!options.sessionsPerWeek) {
          return {
            success: false,
            selectedSlots: [],
            error:
              "Calls per week is required for subscription/class allocation",
          };
        }

        // Calculate slotsPerWeek based on actual session duration
        // slotsPerSession = sessionDurationInHours / 0.5 (since each slot is 30 min)
        // slotsPerWeek = sessionsPerWeek * slotsPerSession
        const slotsPerSession = Math.ceil(
          (options.sessionDurationInHours || 1) / 0.5,
        );
        const slotsPerWeek = options.sessionsPerWeek * slotsPerSession;

        const distributionValidation = validateSlotDistribution(
          selectedSlots,
          slotsPerWeek,
          options.schedulingTimezone,
        );

        if (!distributionValidation.isValid) {
          return {
            success: false,
            selectedSlots: [],
            error: distributionValidation.errorMessage,
          };
        }

        // Every scheduling-timezone day must decompose into complete
        // CONSECUTIVE sessions — a length-modulo check would let scattered
        // fragments reach the required total while forming no real session,
        // which the server then rejects.
        const byDay = SlotCalculationService.groupSlotsByDay(
          selectedSlots,
          options.schedulingTimezone ??
            SlotCalculationService.DEFAULT_SCHEDULING_TIMEZONE,
        );
        for (const [, daySlots] of Array.from(byDay)) {
          const { sessions } = countSessionsForDay(daySlots, slotsPerSession);
          if (sessions * slotsPerSession !== daySlots.length) {
            return {
              success: false,
              selectedSlots: [],
              error: `Each session needs ${slotsPerSession} consecutive slots on one day; an incomplete session is selected.`,
            };
          }
        }
      }

      // Call the allocation service
      const allocationResult = await AllocationService.allocateSlots(
        options.eventType,
        options.eventId,
        selectedSlots,
        {
          idempotencyKey: options.idempotencyKey,
          initialAllocation: options.initialAllocation,
          expectedTentativeSlotCount: options.expectedTentativeSlotCount,
        },
      );

      if (!allocationResult.success) {
        return {
          success: false,
          selectedSlots: [],
          error: allocationResult.error,
          errorCode: allocationResult.errorCode,
          httpStatus: allocationResult.httpStatus,
        };
      }

      return {
        success: true,
        selectedSlots: selectedSlots,
        strategy: "manual",
      };
    } catch (error) {
      console.warn("Manual allocation error:", error);
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        {
          tags: { subsystem: "client", feature: "slot-allocation" },
          extra: { eventType: options.eventType, mode: "manual" },
        },
      );
      return {
        success: false,
        selectedSlots: [],
        error:
          error instanceof Error ? error.message : "Manual allocation failed",
      };
    }
  }

  /**
   * Allocate using the slots the consultee requested (the server's
   * "requested" mode). Formerly named preAllocate.
   */
  static async allocateRequestedSlots(
    options: AllocationOptions,
  ): Promise<AllocationResult> {
    try {
      if (!options.requestedSlots || options.requestedSlots.length === 0) {
        return {
          success: false,
          selectedSlots: [],
          error: "No requested slots provided",
        };
      }

      // Same required-count math as manual/auto, including the in-progress
      // reschedule reduction — the requested path previously skipped it and
      // rejected valid partial reschedules.
      const rawRequired = calculateRequiredSlots(
        options.eventType,
        options.durationInMonths,
        options.sessionsPerWeek,
        options.durationInHours || options.sessionDurationInHours,
        options.startDate,
        options.endDate,
        options.totalSessions,
      );

      const pastCount = options.pastConfirmedSlotCount || 0;
      const requiredSlots =
        isRecurringEventType(options.eventType) && pastCount > 0
          ? Math.max(0, rawRequired - pastCount)
          : rawRequired;

      if (options.requestedSlots.length !== requiredSlots) {
        return {
          success: false,
          selectedSlots: [],
          error: `Requested ${options.requestedSlots.length} slots but need ${requiredSlots}`,
        };
      }

      // Call the allocation service
      const allocationResult = await AllocationService.allocateSlots(
        options.eventType,
        options.eventId,
        options.requestedSlots,
        {
          useRequestedSlots: true,
          idempotencyKey: options.idempotencyKey,
          initialAllocation: options.initialAllocation,
          expectedTentativeSlotCount: options.expectedTentativeSlotCount,
        },
      );

      if (!allocationResult.success) {
        return {
          success: false,
          selectedSlots: [],
          error: allocationResult.error,
          errorCode: allocationResult.errorCode,
          httpStatus: allocationResult.httpStatus,
        };
      }

      return {
        success: true,
        selectedSlots: options.requestedSlots,
        strategy: "requested-slots",
      };
    } catch (error) {
      console.warn("Requested-slots allocation error:", error);
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        {
          tags: { subsystem: "client", feature: "slot-allocation" },
          extra: { eventType: options.eventType, mode: "requested" },
        },
      );
      return {
        success: false,
        selectedSlots: [],
        error:
          error instanceof Error
            ? error.message
            : "Requested-slots allocation failed",
      };
    }
  }
}
