/**
 * Slot Validation Service
 *
 * Unified validation logic for all event types.
 * Single source of truth for validation rules - eliminates duplication across routes.
 */

import { reportSentryError } from "@/lib/observability/report";
import prisma, { type PrismaLike } from "@/lib/prisma";
import {
  AppointmentStatus,
  ScheduleType,
  BookingSource,
  PaymentStatus,
} from "@prisma/client";
import {
  EventType,
  ValidationResult,
  ConsultantAllocationData,
  EventConfig,
} from "./types";
import { SlotCalculationService } from "./SlotCalculationService";
import { SubscriptionValidationService } from "../subscriptionValidation";
import { buildOccupiedAppointmentFilter } from "./occupancyPolicy";
import {
  MAX_CLASS_SESSIONS_PER_DAY,
  MAX_SUBSCRIPTION_SESSIONS_PER_DAY,
} from "./sessionCaps";
import { isMinuteWithinWeeklySlot } from "./slotTimeUtils";

// AE-5/RV-6 — every slot is uniformly 30 minutes. The old slotDurationMinutes
// param invited callers to pass arbitrary values that silently mismatch the
// rest of the booking math; inline the one true duration instead.
const SLOT_DURATION_MS = 30 * 60 * 1000;

/**
 * RV-2 — minimal shape needed to decide whether an overlapping appointment is a
 * live blocker. Both the validator and the allocator build occupancy from the
 * same rule via {@link isOccupiedByLiveAppointment}; keeping it here (rather than
 * duplicating the expiry check) is what stops `/validate` and `findAvailableSlots`
 * from disagreeing on expired APPROVED_PENDING_PAYMENT holds.
 */
export interface LiveAppointmentOccupancy {
  consultation?: {
    status?: AppointmentStatus | null;
    bookingSource?: BookingSource | null;
  } | null;
  subscription?: {
    status?: AppointmentStatus | null;
    bookingSource?: BookingSource | null;
  } | null;
  payment?: Array<{
    expiresAt?: Date | null;
    paymentStatus?: PaymentStatus | null;
  }> | null;
}

/**
 * RV-2 — an overlapping appointment genuinely occupies its slot unless it is an
 * APPROVED_PENDING_PAYMENT request whose payment window has already lapsed (the
 * orphaned-payment case): that slot is free again. Any other state, or a payment
 * that has not expired, still blocks.
 *
 * @param now - injectable clock so callers share a single transaction timestamp.
 */
export function isOccupiedByLiveAppointment(
  appointment: LiveAppointmentOccupancy,
  now: Date = new Date(),
): boolean {
  const request = appointment.consultation ?? appointment.subscription;
  const pendingStatus = request?.status;
  // #873 — free the slot only when EVERY payment row is dead; a later active
  // retry row can still be live even if payment[0] lapsed. A row is dead when
  // the sweep already marked it EXPIRED or its window has passed.
  // A row is dead when the sweep marked it EXPIRED, the gateway FAILED it, or
  // it is still PENDING past its window. Never by the clock alone: a
  // SUCCEEDED row keeps its expiresAt, and its request can sit in PENDING
  // until the confirmation write lands (#1319 review).
  const payments = appointment.payment ?? [];
  const allPaymentsDead =
    payments.length > 0 &&
    payments.every(
      (p) =>
        p.paymentStatus === PaymentStatus.EXPIRED ||
        p.paymentStatus === PaymentStatus.FAILED ||
        (p.paymentStatus === PaymentStatus.PENDING &&
          !!p.expiresAt &&
          new Date(p.expiresAt) < now),
    );

  if (pendingStatus === AppointmentStatus.APPROVED_PENDING_PAYMENT) {
    if (allPaymentsDead) return false;
  }
  // #1319 — a DIRECT_CHECKOUT hold sits in PENDING, not
  // APPROVED_PENDING_PAYMENT (the consultant never approves it), so once its
  // payment lapsed nothing here freed the slot: it stayed blocked until the
  // 15-minute GitHub Actions sweep got round to it. A REQUEST_SUBMITTED
  // PENDING is a different animal — it waits on a human, not a payment.
  if (
    pendingStatus === AppointmentStatus.PENDING &&
    request?.bookingSource === BookingSource.DIRECT_CHECKOUT &&
    allPaymentsDead
  ) {
    return false;
  }
  return true;
}

/**
 * Service for validating slot allocations
 */
export class SlotValidationService {
  constructor(private readonly prismaClient: PrismaLike = prisma) {}

  /**
   * Simple slot availability check (used for lock validation)
   * Only checks for conflicts - no schedule or future validation
   *
   * USE CASE: Re-validation inside distributed lock after acquisition
   * This ensures the slot is still available before creating the booking.
   */
  async checkSlotAvailability(
    slots: Date[],
    consultantUserId: string,
  ): Promise<ValidationResult> {
    return await this.validateNoConflicts(slots, consultantUserId);
  }

  /**
   * #908 — conflict-only re-check run INSIDE the short write transaction after
   * the heavy read/validate was hoisted out (and run under the distributed
   * locks). Converts the common race (a slot taken between the out-of-txn read
   * and the write) into a clean typed conflict instead of a raw #440 GiST
   * constraint throw. Unlike {@link checkSlotAvailability}, it forwards the
   * exclude set and the consultee so the in-txn check matches the out-of-txn one.
   */
  async revalidateConflicts(
    slots: Date[],
    consultantUserId: string,
    excludeAppointmentIds?: string[],
    consulteeUserId?: string,
  ): Promise<ValidationResult> {
    return await this.validateNoConflicts(
      slots,
      consultantUserId,
      excludeAppointmentIds,
      consulteeUserId,
    );
  }

  /**
   * Main validation entry point
   * Routes to appropriate validator based on event type
   *
   * @param excludeAppointmentIds - Appointment IDs to exclude from conflict checks.
   *   Used in "use requested slots" flow so an event's own tentative appointments
   *   are not flagged as conflicts with themselves.
   */
  async validate(
    eventType: EventType,
    eventId: string,
    slots: Date[],
    consultant: ConsultantAllocationData,
    config: EventConfig,
    excludeAppointmentIds?: string[],
    /**
     * Who and what this validation is for, beyond the slots themselves. An
     * object rather than more positional parameters: the signature was at the
     * limit, and a bare trailing boolean at the ninth position reads as nothing
     * at the call site.
     */
    options?: {
      /**
       * #676 AE-1 — when set, the consultee's calendar is checked too, so a
       * consultee can't be double-booked across event types at the same instant.
       */
      consulteeUserId?: string;
      /**
       * The consultant explicitly accepting times outside their own published
       * availability. Skips ONLY the availability-window check — conflicts,
       * caps, scheduling period and future-time all still apply, because those
       * protect other people's bookings rather than the consultant's
       * preference. Callers must have established that the requester is the
       * consultant or a privileged user before setting this.
       */
      overrideAvailabilityWindow?: boolean;
    },
  ): Promise<ValidationResult> {
    // Universal validations (apply to all event types)
    const futureCheck = this.validateSlotsInFuture(slots);
    if (!futureCheck.isValid) return futureCheck;

    if (!options?.overrideAvailabilityWindow) {
      const scheduleCheck = this.validateMatchesSchedule(slots, consultant);
      if (!scheduleCheck.isValid) return scheduleCheck;
    }

    const conflictCheck = await this.validateNoConflicts(
      slots,
      consultant.userId,
      excludeAppointmentIds,
      options?.consulteeUserId,
    );
    if (!conflictCheck.isValid) return conflictCheck;

    // FIX: Server-side scheduling period validation
    // This was only done client-side, which could be bypassed
    // Now enforced on the server for all subscriptions and classes
    if (config.schedulingPeriodStartsAt && config.schedulingPeriodEndsAt) {
      const periodCheck = this.validateSchedulingPeriod(
        slots,
        config.schedulingPeriodStartsAt,
        config.schedulingPeriodEndsAt,
      );
      if (!periodCheck.isValid) return periodCheck;
    }

    // Event-specific validations
    switch (eventType) {
      case "consultation":
        return this.validateConsultation(slots, config);

      case "subscription":
        return this.validateSubscription(
          eventId,
          slots,
          config,
          excludeAppointmentIds,
        );

      case "webinar":
        return this.validateWebinar(slots, config);

      case "class":
        // RV-5 — pass eventId + caller exclusions so the weekly-limit check can
        // seed from this class's existing confirmed slots, matching the allocator.
        return this.validateClass(
          eventId,
          slots,
          config,
          excludeAppointmentIds,
        );

      default:
        return {
          isValid: false,
          errors: [`[VALIDATION] Invalid event type: ${eventType}`],
          warnings: [],
        };
    }
  }

  /**
   * UNIVERSAL VALIDATOR: Ensure all slots are in the future
   *
   * FIX: Added 5-second buffer to prevent race conditions
   *
   * RACE CONDITION SCENARIO (before fix):
   * 1. Auto-allocation finds slot at 10:00:00.000
   * 2. By the time validation runs, it's 10:00:00.001
   * 3. Slot rejected as "in the past"
   * 4. Auto-allocation fails despite valid slot
   *
   * BUFFER RATIONALE:
   * - 5 seconds accounts for processing time between operations
   * - Prevents rejecting slots that become "now" during transaction
   * - Still prevents genuine past slot attempts (minutes/hours old)
   */
  private validateSlotsInFuture(slots: Date[]): ValidationResult {
    const now = new Date();
    // Fixed cutoff computed once — safe even for large slot arrays because
    // the cutoff does not advance as the loop runs.
    const BUFFER_MS = 5000; // 5-second processing time buffer
    const cutoff = new Date(now.getTime() + BUFFER_MS);
    const errors: string[] = [];

    for (const slot of slots) {
      if (slot < cutoff) {
        const secondsUntilSlot = (slot.getTime() - now.getTime()) / 1000;
        errors.push(
          `[VALIDATION] Cannot allocate slots in the past or too soon: ${slot.toLocaleString()} ` +
            `(${secondsUntilSlot >= 0 ? `only ${secondsUntilSlot.toFixed(1)}s` : `${Math.abs(secondsUntilSlot).toFixed(1)}s ago`}). ` +
            `Slots must be at least 5 seconds in the future to allow for processing time.`,
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  /**
   * UNIVERSAL VALIDATOR: Check for conflicts with existing appointments
   *
   * CRITICAL: This prevents double-booking by detecting time range overlaps.
   *
   * WHY RANGE OVERLAP MATTERS:
   * - Each slot is 30 minutes: [startTime, endTime]
   * - Two slots overlap if: slotA.start < slotB.end AND slotB.start < slotA.end
   *
   * EXAMPLE:
   * - Existing: 10:00-10:30 (one slot)
   * - Proposed: 10:00-11:00 (two slots: 10:00-10:30, 10:30-11:00)
   * - Without range check: Only 10:00-10:30 flagged as conflict
   * - With range check: Both slots properly detected as conflicts
   *
   * DATABASE QUERY LOGIC:
   * - startsAt < slotEnd: Existing slot starts before proposed ends
   * - endsAt > slot: Existing slot ends after proposed starts
   * - Together: Detects ANY time period overlap
   */
  private async validateNoConflicts(
    slots: Date[],
    consultantUserId: string,
    excludeAppointmentIds?: string[],
    // #676 AE-1 — the consultee is a participant too; an overlapping slot
    // sharing either party is a real conflict.
    consulteeUserId?: string,
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    if (slots.length === 0) {
      return { isValid: true, errors: [], warnings: [] };
    }

    // FIX Issue #464: Replace N+1 per-slot queries with a single batch query.
    // Previously each slot triggered its own findFirst, causing transaction
    // timeouts (>120s) for subscriptions with thousands of slots.

    // Step 1: Compute time envelope across ALL proposed slots.
    // Slots may not be sorted (checkSlotAvailability doesn't sort),
    // so compute min/max explicitly.
    let earliestStart = slots[0].getTime();
    let latestEnd = slots[0].getTime() + SLOT_DURATION_MS;

    for (const slot of slots) {
      const startMs = slot.getTime();
      const endMs = startMs + SLOT_DURATION_MS;
      if (startMs < earliestStart) earliestStart = startMs;
      if (endMs > latestEnd) latestEnd = endMs;
    }

    // #676 AE-1 — a slot is a conflict if EITHER the consultant or (when
    // present) the consultee already holds an overlapping slot. One query.
    const participantIds = consulteeUserId
      ? [consultantUserId, consulteeUserId]
      : [consultantUserId];

    // Step 2: Single query — find ALL occupied appointments overlapping the envelope
    const conflictingAppointments =
      await this.prismaClient.appointment.findMany({
        where: {
          AND: [
            // FIX Bug #15: Use centralized occupancy policy for consistent conflict detection
            { OR: buildOccupiedAppointmentFilter() },
            // Exclude the event's own appointments from conflict detection.
            // Required for "use requested slots" flow: the event's tentative
            // appointments must not be flagged as conflicts with themselves.
            ...(excludeAppointmentIds && excludeAppointmentIds.length > 0
              ? [{ NOT: { id: { in: excludeAppointmentIds } } }]
              : []),
            {
              slotsOfAppointment: {
                some: {
                  // FIX: All conditions must be inside a single AND array.
                  // Mixing AND:[...] with a sibling relation filter (user:{})
                  // at the same level causes Prisma to silently ignore the
                  // relation condition when using the non-transaction client.
                  AND: [
                    { startsAt: { lt: new Date(latestEnd) } },
                    { endsAt: { gt: new Date(earliestStart) } },
                    { user: { some: { id: { in: participantIds } } } },
                    // Defense-in-depth: a tombstoned slot is not a booking.
                    // No completionStatus filter here — RESCHEDULED rows are
                    // a pending reschedule's live hold and must still block.
                    { deletedAt: null },
                  ],
                },
              },
            },
          ],
        },
        include: {
          slotsOfAppointment: {
            // The include carries the SAME predicate as the `some` filter
            // above: the JS matcher below treats every returned child as a
            // candidate conflict, so an unfiltered collection would let a
            // tombstoned (or non-participating) slot of a qualifying
            // appointment produce a [CONFLICT] the parent-level filter just
            // excluded. CodeRabbit triage on the allocation-audit PR.
            where: {
              AND: [
                { startsAt: { lt: new Date(latestEnd) } },
                { endsAt: { gt: new Date(earliestStart) } },
                { user: { some: { id: { in: participantIds } } } },
                { deletedAt: null },
              ],
            },
            select: { startsAt: true, endsAt: true },
          },
          consultation: {
            include: {
              consultationPlan: true,
              requestedBy: {
                include: { user: true },
              },
            },
          },
          subscription: {
            include: {
              subscriptionPlan: true,
              requestedBy: {
                include: { user: true },
              },
            },
          },
          payment: true, // Need payment data to check expiry
        },
      });

    // Step 3: Match conflicts back to specific proposed slots in JS
    const now = new Date();
    for (const slot of slots) {
      const slotEnd = new Date(slot.getTime() + SLOT_DURATION_MS);

      const existingAppointment = conflictingAppointments.find((appt) =>
        appt.slotsOfAppointment.some(
          (existingSlot) =>
            new Date(existingSlot.startsAt) < slotEnd &&
            new Date(existingSlot.endsAt) > slot,
        ),
      );

      if (existingAppointment) {
        // RV-2 — an expired APPROVED_PENDING_PAYMENT hold leaves its slot free;
        // shared with the allocator so /validate and findAvailableSlots agree.
        if (!isOccupiedByLiveAppointment(existingAppointment, now)) {
          continue;
        }

        // Slot is genuinely booked - add error
        // FIX: Use ISO string so the validate route regex can extract it for structured conflict reporting
        let conflictDetails = `${slot.toISOString()}`;
        if (existingAppointment.consultation) {
          conflictDetails += ` (conflicts with consultation for ${existingAppointment.consultation.requestedBy?.user?.name || "unknown"})`;
        } else if (existingAppointment.subscription) {
          conflictDetails += ` (conflicts with subscription for ${existingAppointment.subscription.requestedBy?.user?.name || "unknown"})`;
        }
        errors.push(`[CONFLICT] Slot already booked: ${conflictDetails}`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  /**
   * UNIVERSAL VALIDATOR: Ensure slots match consultant's schedule
   *
   * FIX Issue #6: Now uses Int (startTimeUtc/endTimeUtc) directly instead of
   * extracting hours/minutes from DateTime objects. This eliminates the
   * complex DateTime-to-minutes conversion that was the source of timezone bugs.
   *
   * Also checks adjacent day's availability for timezone edge cases
   * (e.g., 21:00 UTC Saturday = 02:30 IST Sunday).
   */
  private validateMatchesSchedule(
    slots: Date[],
    consultant: ConsultantAllocationData,
  ): ValidationResult {
    const errors: string[] = [];

    if (consultant.scheduleType === ScheduleType.WEEKLY) {
      const invalidSlots: string[] = [];
      const dayNames = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ];

      // For each slot, check if it falls within ANY weekly availability
      // Also check adjacent day's availability for timezone edge cases
      for (const slot of slots) {
        const slotDay = slot.getUTCDay();
        const slotHours = slot.getUTCHours();
        const slotMinutes = slot.getUTCMinutes();
        const slotTimeMinutes = slotHours * 60 + slotMinutes;

        // Check if this slot matches any availability pattern
        // Delegates to isMinuteWithinWeeklySlot — single source of truth for
        // same-day, overnight, and timezone-compensated day matching
        const matchesAvailability = consultant.slotsOfAvailabilityWeekly.some(
          (availSlot) =>
            isMinuteWithinWeeklySlot(
              slotDay,
              slotTimeMinutes,
              30, // 30-minute slot duration
              availSlot.startDay,
              availSlot.startTimeUtc,
              availSlot.endTimeUtc,
              availSlot.utcOffsetMinutes,
            ),
        );

        if (!matchesAvailability) {
          const timeStr = `${slotHours.toString().padStart(2, "0")}:${slotMinutes.toString().padStart(2, "0")}`;
          invalidSlots.push(`${dayNames[slotDay]} at ${timeStr} UTC`);
        }
      }

      if (invalidSlots.length > 0) {
        const slotWord = invalidSlots.length === 1 ? "slot" : "slots";
        const verbTense = invalidSlots.length === 1 ? "does" : "do";
        errors.push(
          `[OUTSIDE_AVAILABILITY] The selected ${slotWord} ${verbTense} not match the consultant's available days and times. ` +
            `Please choose from the green "Available" slots shown in the calendar.`,
        );
      }
    } else {
      // Custom schedule — CONTAINMENT, the same rule the weekly arm above
      // applies via isMinuteWithinWeeklySlot. #1320: this used to test overlap
      // (`slot < availableEnd && availableStart < slotEnd`), so a 30-minute
      // atom hanging half outside a custom row passed manual allocation and
      // was then rejected by checkout, which has always required the whole
      // window to sit inside published availability. Containment still accepts
      // the case the overlap test was introduced for — an atom the calendar
      // broke out of a larger row — because such an atom is inside the row.

      let hasInvalidSlots = false;
      const invalidSlotsList: string[] = [];
      for (const slot of slots) {
        // Calculate the end time of the requested slot (30-minute slots)
        const slotEnd = new Date(slot.getTime() + 30 * 60 * 1000);

        // Check if this slot sits wholly inside ANY available custom slot
        const isContained = consultant.slotsOfAvailabilityCustom.some(
          (availableSlot) => {
            const availableStart = new Date(availableSlot.startsAt);
            const availableEnd = new Date(availableSlot.endsAt);
            return slot >= availableStart && slotEnd <= availableEnd;
          },
        );

        if (!isContained) {
          hasInvalidSlots = true;
          invalidSlotsList.push(slot.toISOString());
        }
      }

      if (hasInvalidSlots) {
        console.warn("[SlotValidationService] Invalid slots found:", {
          invalidSlots: invalidSlotsList,
        });

        const slotWord = slots.length === 1 ? "slot" : "slots";
        const verbTense = slots.length === 1 ? "is" : "are";

        // Check if this looks like a consecutive slot issue (some slots valid, some not)
        const validSlotCount = slots.filter((slot) => {
          const slotEnd = new Date(slot.getTime() + 30 * 60 * 1000);
          return consultant.slotsOfAvailabilityCustom.some((availableSlot) => {
            const availableStart = new Date(availableSlot.startsAt);
            const availableEnd = new Date(availableSlot.endsAt);
            return slot >= availableStart && slotEnd <= availableEnd;
          });
        }).length;
        const isConsecutiveIssue =
          validSlotCount > 0 && validSlotCount < slots.length;

        if (isConsecutiveIssue) {
          errors.push(
            `[OUTSIDE_AVAILABILITY] The consultant doesn't have enough consecutive availability for this ${slots.length === 2 ? "1-hour" : `${slots.length * 0.5}-hour`} event. ` +
              `Only ${validSlotCount} of ${slots.length} required time slots ${verbTense} available. ` +
              `The consultant needs to add more consecutive time slots to their schedule.`,
          );
        } else {
          errors.push(
            `[OUTSIDE_AVAILABILITY] The selected ${slotWord} ${verbTense} not available in the consultant's schedule. ` +
              `Please choose from the green "Available" slots shown in the calendar. ` +
              `Only specific times are available for booking.`,
          );
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  /**
   * UNIVERSAL VALIDATOR: Check scheduling period boundaries
   *
   * SECURITY: This is now enforced server-side (was previously only client-side)
   * Prevents bypassing scheduling period restrictions via direct API calls.
   *
   * APPLIES TO:
   * - Subscriptions: Must schedule all calls within [startDate, endDate]
   * - Classes: Must schedule all sessions within [startDate, endDate]
   *
   * NOT APPLICABLE TO:
   * - Consultations: One-time events, no scheduling period
   * - Webinars: One-time events, no scheduling period
   */
  private validateSchedulingPeriod(
    slots: Date[],
    startDate: Date,
    endDate: Date,
  ): ValidationResult {
    const errors: string[] = [];

    for (const slot of slots) {
      const slotEnd = new Date(slot.getTime() + 30 * 60 * 1000);
      if (slot < startDate || slotEnd > endDate) {
        errors.push(
          `[OUTSIDE_AVAILABILITY] Slot ${slot.toLocaleString()} is outside the scheduling period ` +
            `(${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}). ` +
            `All slots must be scheduled within this date range.`,
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  /**
   * UNIVERSAL VALIDATOR: Check if slots are consecutive
   * Uses 1-second tolerance for timezone/precision issues
   */
  private validateConsecutiveSlots(slots: Date[]): ValidationResult {
    if (slots.length <= 1) {
      return { isValid: true, errors: [], warnings: [] };
    }

    const sortedSlots = [...slots].sort((a, b) => a.getTime() - b.getTime());
    const toleranceMs = 1000; // 1 second tolerance
    const errors: string[] = [];

    for (let i = 1; i < sortedSlots.length; i++) {
      const prevSlot = sortedSlots[i - 1];
      const currentSlot = sortedSlots[i];

      // Expected: previous slot + 30 minutes = current slot
      const expectedNextTime = prevSlot.getTime() + 30 * 60 * 1000;
      const timeDiff = Math.abs(currentSlot.getTime() - expectedNextTime);

      if (timeDiff > toleranceMs) {
        errors.push(
          `[VALIDATION] Slots must be consecutive. Gap detected between ${prevSlot.toLocaleString()} and ${currentSlot.toLocaleString()}`,
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  /**
   * UNIVERSAL VALIDATOR: Check if all slots are on the same scheduling-
   * timezone day (ADR B9). The key never depends on the server's own
   * timezone and matches the client's dayKey check.
   */
  private validateSameDaySlots(
    slots: Date[],
    schedulingTimezone?: string,
  ): ValidationResult {
    if (slots.length <= 1) {
      return { isValid: true, errors: [], warnings: [] };
    }

    const firstSlotDay = SlotCalculationService.dayKey(
      slots[0],
      schedulingTimezone,
    );
    const errors: string[] = [];

    for (const slot of slots) {
      const slotDay = SlotCalculationService.dayKey(slot, schedulingTimezone);
      if (slotDay !== firstSlotDay) {
        errors.push(
          `[VALIDATION] All slots must be on the same day. Found slots on ${firstSlotDay} and ${slotDay}`,
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  /**
   * EVENT-SPECIFIC: Validate consultation slots
   * Rules: Must be same day, consecutive, and match required duration
   */
  private validateConsultation(
    slots: Date[],
    config: EventConfig,
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Calculate required slots
    const duration = config.durationInHours || config.sessionDurationInHours;

    // FIX: Validate duration before use
    try {
      SlotCalculationService.validateDuration(
        duration,
        "Consultation duration",
      );
    } catch (error) {
      // A misconfigured duration failing validation is a modelled answer
      // (bad plan config), not a fault — reported at info for visibility.
      reportSentryError(error, {
        subsystem: "scheduling",
        op: "slot-validation",
        expected: true,
        extra: { phase: "consultation-duration" },
      });
      return {
        isValid: false,
        errors: [
          `[VALIDATION] ${error instanceof Error ? error.message : "Invalid consultation duration"}`,
        ],
        warnings: [],
      };
    }

    // After validation, duration is guaranteed to be a valid number
    const requiredSlots = SlotCalculationService.getSlotsPerCall(duration!);

    // Check slot count
    if (slots.length !== requiredSlots) {
      errors.push(
        `[VALIDATION] Consultation requires exactly ${requiredSlots} slot${requiredSlots !== 1 ? "s" : ""} (${duration!} hour${duration! > 1 ? "s" : ""}) but ${slots.length} provided`,
      );
    }

    // Check same day (BEFORE consecutive check - more important)
    const sameDayCheck = this.validateSameDaySlots(
      slots,
      config?.schedulingTimezone,
    );
    if (!sameDayCheck.isValid) {
      errors.push(
        "[VALIDATION] Consultation is a one-day event - all slots must be on the same day",
      );
      // Don't check consecutiveness if not same day
      return { isValid: false, errors, warnings };
    }

    // Check consecutive
    const consecutiveCheck = this.validateConsecutiveSlots(slots);
    if (!consecutiveCheck.isValid) {
      errors.push(
        "[VALIDATION] Consultation slots must be consecutive (no gaps allowed)",
      );
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * EVENT-SPECIFIC: Validate subscription slots
   * Uses the existing SubscriptionValidationService
   */
  private async validateSubscription(
    subscriptionId: string,
    slots: Date[],
    config: EventConfig,
    excludeAppointmentIds?: string[],
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate per-session consecutiveness (matches validateClass behavior)
    // Without this, non-adjacent slots (e.g., 09:00 and 11:00) could be
    // grouped into a single session, creating appointments with time gaps
    const sessionDuration = config.sessionDurationInHours || 1;
    const slotsPerSession =
      SlotCalculationService.getSlotsPerCall(sessionDuration);

    if (slotsPerSession > 1) {
      const sortedSlots = [...slots].sort((a, b) => a.getTime() - b.getTime());

      for (let i = 0; i < sortedSlots.length; i += slotsPerSession) {
        const sessionSlots = sortedSlots.slice(i, i + slotsPerSession);
        const consecutiveCheck = this.validateConsecutiveSlots(sessionSlots);
        if (!consecutiveCheck.isValid) {
          const sessionNum = Math.floor(i / slotsPerSession) + 1;
          errors.push(
            `[VALIDATION] Session ${sessionNum} slots must be consecutive (no gaps allowed)`,
          );
        }
      }

      if (errors.length > 0) {
        return { isValid: false, errors, warnings };
      }
    }

    // Reject incomplete sessions (matches validateClass behavior)
    if (slotsPerSession > 1 && slots.length % slotsPerSession !== 0) {
      errors.push(
        `[VALIDATION] Subscription requires slot count to be a multiple of ${slotsPerSession} ` +
          `(${sessionDuration}-hour sessions), but ${slots.length} slots were provided`,
      );
      return { isValid: false, errors, warnings };
    }

    const validationService = new SubscriptionValidationService(
      this.prismaClient as PrismaLike,
    );

    // Exclude tentative appointments from weekly call count.
    // During re-allocation after a reschedule, the old tentative slots still
    // exist in the DB and would otherwise be counted as "existing calls",
    // causing a false weekly-limit violation when the consultant proposes
    // the same number of new slots (1 per week).
    const tentativeAppointments = await this.prismaClient.appointment.findMany({
      where: {
        subscriptionId,
        slotsOfAppointment: { some: { isTentative: true } },
      },
      select: { id: true },
    });
    const tentativeIds = tentativeAppointments.map((a) => a.id);
    // Merge caller-provided exclusions with tentative lookup for reliability
    const allExcludeIds = Array.from(
      new Set([...(excludeAppointmentIds || []), ...tentativeIds]),
    );

    const result = await validationService.validateSubscriptionSlots(
      subscriptionId,
      slots.map((s) => s.toISOString()),
      allExcludeIds,
    );

    // #898 follow-up — server-side per-DAY cap (subscription ≤1/day). The
    // SubscriptionValidationService enforces the weekly limit; the per-day cap
    // previously lived only in allocation selection + the client guard.
    // Constant shared with the allocator (utils/slotAllocation/sessionCaps.ts)
    // so selection and validation can never disagree.
    const subscriptionAppointments =
      await this.prismaClient.appointment.findMany({
        where: { subscriptionId },
        select: {
          id: true,
          slotsOfAppointment: { select: { startsAt: true, isTentative: true } },
        },
      });
    const perDayErrors = this.validatePerDaySessionCap(
      subscriptionAppointments,
      new Set(allExcludeIds),
      slots,
      slotsPerSession,
      MAX_SUBSCRIPTION_SESSIONS_PER_DAY,
      config.schedulingTimezone,
    );
    return {
      isValid: result.isValid && perDayErrors.length === 0,
      errors: [...errors, ...result.errors, ...perDayErrors],
      warnings: [...warnings, ...result.warnings],
    };
  }

  /**
   * EVENT-SPECIFIC: Validate webinar slots
   * Rules: Must be consecutive and match required duration
   */
  private validateWebinar(
    slots: Date[],
    config: EventConfig,
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Calculate required slots
    const duration = config.durationInHours || config.sessionDurationInHours;

    // FIX: Validate duration before use
    try {
      SlotCalculationService.validateDuration(duration, "Webinar duration");
    } catch (error) {
      // Same reasoning as validateConsultation's duration guard: a modelled
      // config-validation answer, reported at info.
      reportSentryError(error, {
        subsystem: "scheduling",
        op: "slot-validation",
        expected: true,
        extra: { phase: "webinar-duration" },
      });
      return {
        isValid: false,
        errors: [
          `[VALIDATION] ${error instanceof Error ? error.message : "Invalid webinar duration"}`,
        ],
        warnings: [],
      };
    }

    // After validation, duration is guaranteed to be a valid number
    const requiredSlots = SlotCalculationService.getSlotsPerCall(duration!);

    // Check slot count
    if (slots.length !== requiredSlots) {
      const durationText = duration! === 1 ? "1 hour" : `${duration!} hours`;
      errors.push(
        `[VALIDATION] Webinar (${durationText}) requires exactly ${requiredSlots} consecutive slot${requiredSlots > 1 ? "s" : ""}, but ${slots.length} provided`,
      );
    }

    // Check consecutive
    if (requiredSlots > 1) {
      const consecutiveCheck = this.validateConsecutiveSlots(slots);
      if (!consecutiveCheck.isValid) {
        errors.push("[VALIDATION] Webinar slots must be consecutive");
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * EVENT-SPECIFIC: Validate class slots
   * Rules: Must respect weekly limits and session grouping
   *
   * RV-5 — the weekly-limit check seeds each week from this class's already
   * confirmed (non-tentative) sessions, mirroring the allocator's
   * `existingCallsPerWeek`. Without this seed a partial reschedule that proposes
   * a full week of new sessions passes validate but exceeds the real limit once
   * the surviving confirmed sessions are counted.
   *
   * @param excludeAppointmentIds - caller exclusions (e.g. the "use requested
   *   slots" flow). Merged with this class's own tentative appointments so a
   *   tentative session being replaced is never counted toward the seed.
   */
  private async validateClass(
    classId: string,
    slots: Date[],
    config: EventConfig,
    excludeAppointmentIds?: string[],
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate configuration
    if (!config.sessionsPerWeek) {
      return {
        isValid: false,
        errors: [
          "[VALIDATION] Classes per week is required for class validation",
        ],
        warnings: [],
      };
    }

    if (!config.sessionDurationInHours) {
      return {
        isValid: false,
        errors: [
          "[VALIDATION] Session duration is required for class validation",
        ],
        warnings: [],
      };
    }

    // FIX: Validate duration before use
    try {
      SlotCalculationService.validateDuration(
        config.sessionDurationInHours,
        "Session duration",
      );
    } catch (error) {
      // Same reasoning as the consultation/webinar duration guards.
      reportSentryError(error, {
        subsystem: "scheduling",
        op: "slot-validation",
        expected: true,
        extra: { phase: "class-session-duration" },
      });
      return {
        isValid: false,
        errors: [
          `[VALIDATION] ${error instanceof Error ? error.message : "Invalid session duration"}`,
        ],
        warnings: [],
      };
    }

    const slotsPerSession = SlotCalculationService.getSlotsPerCall(
      config.sessionDurationInHours,
    );

    // Validate slot count is a multiple of slotsPerSession (incomplete session check)
    if (slots.length % slotsPerSession !== 0) {
      errors.push(
        `[VALIDATION] ${slots.length} slots provided but needs multiples of ${slotsPerSession} (incomplete session)`,
      );
    }

    // Validate per-session consecutiveness (matches subscription validation).
    // Grouping by UTC day is incorrect because cross-midnight sessions split
    // slots across two UTC dates, causing false "non-consecutive" errors.
    if (slotsPerSession > 1) {
      const sortedSlots = [...slots].sort((a, b) => a.getTime() - b.getTime());

      for (let i = 0; i < sortedSlots.length; i += slotsPerSession) {
        const sessionSlots = sortedSlots.slice(i, i + slotsPerSession);
        const consecutiveCheck = this.validateConsecutiveSlots(sessionSlots);
        if (!consecutiveCheck.isValid) {
          const sessionNum = Math.floor(i / slotsPerSession) + 1;
          errors.push(
            `[VALIDATION] Session ${sessionNum} slots must be consecutive (no gaps allowed)`,
          );
        }
      }
    }

    // RV-5 — seed each week with this class's surviving confirmed sessions.
    // Fetch the class's appointments and exclude the tentative ones (and any
    // caller exclusions) that are about to be replaced, so the seed reflects
    // exactly the calls the allocator would also count.
    const classAppointments = await this.prismaClient.appointment.findMany({
      where: { classId },
      select: {
        id: true,
        slotsOfAppointment: {
          select: { startsAt: true, isTentative: true },
        },
      },
    });
    const tentativeIds = classAppointments
      .filter((a) => a.slotsOfAppointment.some((s) => s.isTentative))
      .map((a) => a.id);
    const excludeSet = new Set([
      ...(excludeAppointmentIds || []),
      ...tentativeIds,
    ]);

    // One confirmed appointment = one session, keyed by its earliest slot's
    // week (same scheduling-timezone key the allocator and groupSlotsByWeek
    // use, ADR B9).
    const existingSessionsPerWeek = new Map<string, number>();
    for (const appt of classAppointments) {
      if (excludeSet.has(appt.id)) continue;
      if (appt.slotsOfAppointment.length === 0) continue;
      const firstSlot = appt.slotsOfAppointment.reduce((earliest, s) =>
        new Date(s.startsAt) < new Date(earliest.startsAt) ? s : earliest,
      );
      const weekKey = SlotCalculationService.weekKey(
        new Date(firstSlot.startsAt),
        config.schedulingTimezone,
      );
      existingSessionsPerWeek.set(
        weekKey,
        (existingSessionsPerWeek.get(weekKey) || 0) + 1,
      );
    }

    // Validate weekly limits
    const slotsByWeek = SlotCalculationService.groupSlotsByWeek(
      slots.map((s) => ({
        startTime: s,
        endTime: new Date(s.getTime() + SLOT_DURATION_MS),
        isAvailable: true,
        isBooked: false,
      })),
      config.schedulingTimezone ??
        SlotCalculationService.DEFAULT_SCHEDULING_TIMEZONE,
    );

    slotsByWeek.forEach((weekSlots, weekKey) => {
      const proposedSessions = Math.floor(weekSlots.length / slotsPerSession);
      const sessionsThisWeek =
        proposedSessions + (existingSessionsPerWeek.get(weekKey) || 0);
      if (sessionsThisWeek > config.sessionsPerWeek!) {
        errors.push(
          `[WEEKLY_LIMIT] Week of ${weekKey} has ${sessionsThisWeek} sessions but max is ${config.sessionsPerWeek}`,
        );
      }
    });

    // #898 follow-up — server-side per-DAY cap (class ≤2/day). Was only enforced
    // at allocation-selection time + the client guard, so a hand-crafted manual
    // allocate could stack same-day sessions. Constant shared with the
    // allocator (utils/slotAllocation/sessionCaps.ts).
    errors.push(
      ...this.validatePerDaySessionCap(
        classAppointments,
        excludeSet,
        slots,
        slotsPerSession,
        MAX_CLASS_SESSIONS_PER_DAY,
        config.schedulingTimezone,
      ),
    );

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * #898 follow-up — server-side per-DAY session cap (subscription 1/day,
   * class 2/day). Keyed by the event's scheduling-timezone day via
   * SlotCalculationService.dayKey (ADR B9) — the same key the client guards
   * and auto-allocate use. The old toDateString() key depended on the
   * server's local timezone, so verdicts could differ between environments
   * and from the client. One Appointment = one session, keyed by its first
   * slot's day; tentative/excluded appointments are skipped.
   */
  private validatePerDaySessionCap(
    existingAppointments: {
      id: string;
      slotsOfAppointment: { startsAt: Date | string; isTentative: boolean }[];
    }[],
    excludeSet: Set<string>,
    slots: Date[],
    slotsPerSession: number,
    maxPerDay: number,
    schedulingTimezone?: string,
  ): string[] {
    const errors: string[] = [];
    const existingPerDay = new Map<string, number>();
    for (const appt of existingAppointments) {
      if (excludeSet.has(appt.id)) continue;
      if (appt.slotsOfAppointment.length === 0) continue;
      const firstSlot = appt.slotsOfAppointment.reduce((earliest, s) =>
        new Date(s.startsAt) < new Date(earliest.startsAt) ? s : earliest,
      );
      const dayKey = SlotCalculationService.dayKey(
        new Date(firstSlot.startsAt),
        schedulingTimezone,
      );
      existingPerDay.set(dayKey, (existingPerDay.get(dayKey) || 0) + 1);
    }
    // Sort a copy first — stepping by slotsPerSession assumes session-ordered
    // input, and requested-mode slots come from the DB unordered.
    const orderedSlots = [...slots].sort((a, b) => a.getTime() - b.getTime());
    const proposedPerDay = new Map<string, number>();
    for (let i = 0; i < orderedSlots.length; i += slotsPerSession) {
      const dayKey = SlotCalculationService.dayKey(
        orderedSlots[i],
        schedulingTimezone,
      );
      proposedPerDay.set(dayKey, (proposedPerDay.get(dayKey) || 0) + 1);
    }
    proposedPerDay.forEach((count, dayKey) => {
      const total = count + (existingPerDay.get(dayKey) || 0);
      if (total > maxPerDay) {
        errors.push(
          `[DAILY_LIMIT] ${dayKey} has ${total} session(s) but the max is ${maxPerDay} per day`,
        );
      }
    });
    return errors;
  }
}
