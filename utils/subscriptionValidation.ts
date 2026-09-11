import type { PrismaLike } from "@/lib/prisma";
import { isWithinInterval } from "date-fns";
import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";
import { OCCUPIED_REQUEST_STATUSES } from "@/utils/slotAllocation/occupancyPolicy";

type AppointmentSlotRecord = { startsAt: Date };
type AppointmentWithSlots = {
  id: string;
  slotsOfAppointment: AppointmentSlotRecord[];
};

interface WeeklyCallInfo {
  weekStart: Date;
  weekEnd: Date;
  existingCalls: number;
  proposedCalls: number;
  maxCalls: number;
  canScheduleMore: boolean;
  availableSlots: number;
}

interface SubscriptionValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  weeklyInfo: WeeklyCallInfo[];
  totalCallsScheduled: number;
  maxTotalCalls: number;
  subscriptionPeriod: {
    start: Date;
    end: Date;
  };
}

/**
 * Enhanced subscription validation service that checks week-based call limits
 * and ensures appointments are within subscription date range.
 *
 * KEY FEATURES:
 * - Uses Sunday-to-Saturday week boundaries for consistent week counting
 * - Validates consecutive slots with timezone tolerance (1 second)
 * - Prevents auto-filling past weeks with maximum calls
 * - Handles month-end overflow issues in date calculations
 *
 * WEEK COUNTING LOGIC:
 * - Weeks are defined as Sunday 00:00 to Saturday 23:59
 * - First week: Sunday of the week containing subscription start date
 * - Last week: Sunday of the week containing subscription end date
 * - Example: Jan 1 (Mon) to Feb 1 (Thu) = 5 weeks (not 4.33)
 */
export class SubscriptionValidationService {
  constructor(private readonly prisma: PrismaLike) {}

  /**
   * Validates subscription slot allocation based on weekly limits and subscription period
   */
  async validateSubscriptionSlots(
    subscriptionId: string,
    proposedSlots: string[],
    excludeAppointmentIds: string[] = [],
  ): Promise<SubscriptionValidationResult> {
    // Get subscription details
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        subscriptionPlan: true,
        requestedBy: {
          include: {
            user: true,
          },
        },
      },
    });

    if (!subscription) {
      throw new Error("Subscription not found");
    }

    const { subscriptionPlan } = subscription;
    // ADR B9 — all weekly/daily buckets below use the subscription's
    // scheduling timezone (column default Asia/Kolkata).
    const schedulingTimezone =
      subscription.schedulingTimezone ??
      SlotCalculationService.DEFAULT_SCHEDULING_TIMEZONE;
    const proposedSlotDates = proposedSlots.map((slot) => new Date(slot));

    // FIXED: Use the correct Sunday-to-Saturday week counting logic
    const exactWeeks = SlotCalculationService.countWeeks(
      subscription.schedulingPeriodStartsAt,
      subscription.schedulingPeriodEndsAt,
    );

    // Initialize result
    const result: SubscriptionValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
      weeklyInfo: [],
      totalCallsScheduled: 0,
      maxTotalCalls: subscriptionPlan.sessionsPerWeek * exactWeeks,
      subscriptionPeriod: {
        start: subscription.schedulingPeriodStartsAt,
        end: subscription.schedulingPeriodEndsAt,
      },
    };

    // Check if proposed slots are within subscription period
    const subscriptionPeriodValid = this.validateSubscriptionPeriod(
      proposedSlotDates,
      subscription.schedulingPeriodStartsAt,
      subscription.schedulingPeriodEndsAt,
    );

    if (!subscriptionPeriodValid.isValid) {
      result.isValid = false;
      result.errors.push(...subscriptionPeriodValid.errors);
    }

    // Get existing appointments for this subscription
    const existingAppointments = await this.getExistingSubscriptionAppointments(
      subscriptionId,
      excludeAppointmentIds,
    );

    // Group existing appointments by week
    const existingCallsByWeek = this.groupAppointmentsByWeek(
      existingAppointments,
      schedulingTimezone,
    );

    // Group proposed slots by week
    const proposedCallsByWeek = this.groupSlotsByWeek(
      proposedSlotDates,
      subscriptionPlan.sessionDurationInHours,
      schedulingTimezone,
    );

    // Generate weekly info for the entire subscription period
    const weeklyInfo = this.generateWeeklyInfo(
      subscription.schedulingPeriodStartsAt,
      subscription.schedulingPeriodEndsAt,
      subscriptionPlan.sessionsPerWeek,
      existingCallsByWeek,
      proposedCallsByWeek,
      schedulingTimezone,
    );

    result.weeklyInfo = weeklyInfo;
    // Total calls are determined by counting completed weeks (auto-completed) plus any scheduled/proposed calls within the current and future weeks
    result.totalCallsScheduled = weeklyInfo.reduce(
      (sum, w) => sum + w.existingCalls,
      0,
    );

    // Validate weekly limits
    const weeklyValidation = this.validateWeeklyLimits(weeklyInfo);
    // FIX: Always push warnings (e.g. "fully booked" notices) regardless of error state.
    // Previously warnings were only pushed inside the `if (!isValid)` block, which
    // silently discarded them when no errors existed.
    result.warnings.push(...weeklyValidation.warnings);
    if (!weeklyValidation.isValid) {
      result.isValid = false;
      result.errors.push(...weeklyValidation.errors);
    }

    // Validate total call limits
    if (result.totalCallsScheduled > result.maxTotalCalls) {
      result.isValid = false;
      result.errors.push(
        `Total calls (${result.totalCallsScheduled}) exceed subscription limit (${result.maxTotalCalls})`,
      );
    }

    return result;
  }

  /**
   * Validates if slots are within the subscription period
   */
  private validateSubscriptionPeriod(
    slotDates: Date[],
    subscriptionStart: Date,
    subscriptionEnd: Date,
  ): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const slotDate of slotDates) {
      if (
        !isWithinInterval(slotDate, {
          start: subscriptionStart,
          end: subscriptionEnd,
        })
      ) {
        errors.push(
          `Slot ${slotDate.toLocaleDateString()} is outside subscription period (${subscriptionStart.toLocaleDateString()} - ${subscriptionEnd.toLocaleDateString()})`,
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Gets existing appointments for a subscription
   */
  private async getExistingSubscriptionAppointments(
    subscriptionId: string,
    excludeAppointmentIds: string[] = [],
  ): Promise<AppointmentWithSlots[]> {
    return await this.prisma.appointment.findMany({
      where: {
        subscriptionId,
        id: {
          notIn: excludeAppointmentIds,
        },
        // FIX Bug #15: Use centralized occupancy statuses for consistency
        subscription: {
          status: {
            in: OCCUPIED_REQUEST_STATUSES,
          },
        },
      },
      include: {
        slotsOfAppointment: true,
      },
    });
  }

  /**
   * Groups appointments by week, counting each appointment as one call.
   */
  private groupAppointmentsByWeek(
    appointments: AppointmentWithSlots[],
    schedulingTimezone: string,
  ): Map<string, number> {
    const weeklyCallCount = new Map<string, number>();

    for (const appointment of appointments) {
      if (appointment.slotsOfAppointment.length === 0) continue;

      // FIX: Previously iterated over each slot and incremented by 1 per slot.
      // A 1-hour session (2 slots) was counted as 2 calls instead of 1.
      // Now counts each appointment as 1 call using the earliest slot's week.
      const firstSlot = appointment.slotsOfAppointment.reduce(
        (earliest, slot) =>
          new Date(slot.startsAt) < new Date(earliest.startsAt)
            ? slot
            : earliest,
      );
      const weekKey = SlotCalculationService.weekKey(
        new Date(firstSlot.startsAt),
        schedulingTimezone,
      );

      weeklyCallCount.set(weekKey, (weeklyCallCount.get(weekKey) || 0) + 1);
    }

    return weeklyCallCount;
  }

  /**
   * Groups proposed slots by week and converts to confirmed call count
   */
  private groupSlotsByWeek(
    slotDates: Date[],
    sessionDurationInHours: number,
    schedulingTimezone: string,
  ): Map<string, number> {
    const slotsPerCall = Math.ceil(sessionDurationInHours / 0.5); // 30-minute intervals

    // Group slots by scheduling-timezone day first (server-tz-independent;
    // matches the client's dayKey bucketing).
    const slotsByDay = new Map<string, Date[]>();
    for (const slotDate of slotDates) {
      const dayKey = SlotCalculationService.dayKey(
        slotDate,
        schedulingTimezone,
      );
      if (!slotsByDay.has(dayKey)) {
        slotsByDay.set(dayKey, []);
      }
      slotsByDay.get(dayKey)!.push(slotDate);
    }

    const getWeekString = (date: Date): string =>
      // Must match the key format used by generateWeeklyInfo and
      // groupAppointmentsByWeek — all three use SlotCalculationService.weekKey.
      SlotCalculationService.weekKey(date, schedulingTimezone);

    // FIX: Use 1-second tolerance for floating-point precision issues
    // Matches SlotValidationService behavior for consistency
    // WHY: Date arithmetic and timezone conversions can introduce sub-second precision errors
    const TOLERANCE_MS = 1000; // 1 second tolerance

    /**
     * Count how many complete calls exist in a day's worth of slots.
     *
     * Previously used exact-length equality (daySlots.length === slotsPerCall),
     * which meant 2 calls on the same day (e.g., 4 slots with slotsPerCall=2)
     * would count as 0 calls because 4 !== 2.
     *
     * Now sorts slots chronologically and greedily groups consecutive slots
     * into calls of size `slotsPerCall`, correctly counting multiple calls
     * on the same day.
     */
    const countCallsInDay = (daySlots: Date[]): number => {
      if (daySlots.length < slotsPerCall) return 0;

      const sortedSlots = [...daySlots].sort(
        (a, b) => a.getTime() - b.getTime(),
      );

      let callCount = 0;
      let consecutiveCount = 1; // Current run of consecutive slots

      for (let i = 1; i < sortedSlots.length; i++) {
        const prevEnd = new Date(sortedSlots[i - 1].getTime() + 30 * 60 * 1000); // Add 30 min
        const currentStart = sortedSlots[i];
        const timeDiff = Math.abs(currentStart.getTime() - prevEnd.getTime());

        if (timeDiff <= TOLERANCE_MS) {
          // This slot is consecutive with the previous one
          consecutiveCount++;
        } else {
          // Gap detected — check if the previous run formed complete call(s)
          callCount += Math.floor(consecutiveCount / slotsPerCall);
          consecutiveCount = 1;
        }
      }

      // Don't forget the last run
      callCount += Math.floor(consecutiveCount / slotsPerCall);

      return callCount;
    };

    // Process each day to count confirmed calls per week
    const weekCalls = new Map<string, number>();
    slotsByDay.forEach((daySlots) => {
      if (daySlots.length === 0) return;

      const weekString = getWeekString(daySlots[0]);

      if (!weekCalls.has(weekString)) {
        weekCalls.set(weekString, 0);
      }

      // Count all complete calls in this day (handles multiple calls per day)
      const callsThisDay = countCallsInDay(daySlots);
      if (callsThisDay > 0) {
        weekCalls.set(weekString, weekCalls.get(weekString)! + callsThisDay);
      }
    });

    return weekCalls;
  }

  /**
   * Generates weekly information for the entire subscription period
   *
   * SAFETY: Includes maximum iteration limit to prevent infinite loops
   * in case of malformed dates or bugs in date-fns library.
   *
   * MAX_WEEKS = 520 weeks = 10 years
   * - Reasonable upper bound for any subscription
   * - Protects against infinite loops from bad data
   * - Example malformed dates: startDate="3000-01-01", endDate="2020-01-01"
   */
  private generateWeeklyInfo(
    subscriptionStart: Date,
    subscriptionEnd: Date,
    sessionsPerWeek: number,
    existingCalls: Map<string, number>,
    proposedCalls: Map<string, number>,
    schedulingTimezone: string,
  ): WeeklyCallInfo[] {
    // FIX: Add maximum iteration limit to prevent infinite loops
    const MAX_WEEKS = 520; // 10 years - reasonable upper bound for subscriptions
    let weekCount = 0;

    const weeklyInfo: WeeklyCallInfo[] = [];
    let currentWeek = SlotCalculationService.startOfWeekSundayInTz(
      subscriptionStart,
      schedulingTimezone,
    );

    while (currentWeek <= subscriptionEnd) {
      weekCount++;

      // Safety check: prevent infinite loops from malformed dates
      if (weekCount > MAX_WEEKS) {
        throw new Error(
          `Subscription period exceeds maximum duration (${MAX_WEEKS} weeks / 10 years). ` +
            `Start: ${subscriptionStart.toISOString()}, End: ${subscriptionEnd.toISOString()}. ` +
            `Please verify the subscription dates are correct.`,
        );
      }

      // Next Sunday 00:00 in the scheduling timezone; +8 days then normalize
      // stays correct across DST transitions.
      const nextWeek = SlotCalculationService.startOfWeekSundayInTz(
        new Date(currentWeek.getTime() + 8 * 24 * 60 * 60 * 1000),
        schedulingTimezone,
      );
      const weekEnd = new Date(nextWeek.getTime() - 1);
      const weekKey = SlotCalculationService.weekKey(
        currentWeek,
        schedulingTimezone,
      );

      const existingCallCountDb = existingCalls.get(weekKey) || 0;
      const proposedCallCount = proposedCalls.get(weekKey) || 0;

      // FIXED: Don't auto-fill past weeks with max calls, use actual data
      const today = new Date();
      const isPastWeek = weekEnd < today;

      // Only use actual existing call data, don't auto-fill past weeks
      const effectiveExistingCalls = existingCallCountDb;
      const totalCalls = effectiveExistingCalls + proposedCallCount;

      weeklyInfo.push({
        weekStart: new Date(currentWeek),
        weekEnd: new Date(weekEnd),
        existingCalls: effectiveExistingCalls,
        proposedCalls: proposedCallCount,
        maxCalls: sessionsPerWeek,
        canScheduleMore: !isPastWeek && totalCalls < sessionsPerWeek,
        availableSlots: isPastWeek ? 0 : Math.max(0, sessionsPerWeek - totalCalls),
      });

      currentWeek = nextWeek;
    }

    return weeklyInfo;
  }

  /**
   * Validates weekly call limits.
   */
  private validateWeeklyLimits(weeklyInfo: WeeklyCallInfo[]): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const week of weeklyInfo) {
      // FIX: Previously computed (maxCalls - availableSlots) then checked > maxCalls.
      // Since availableSlots = Math.max(0, maxCalls - totalCalls), that condition
      // was mathematically impossible — the validation never caught violations.
      const totalCallsForWeek = week.existingCalls + week.proposedCalls;

      if (totalCallsForWeek > week.maxCalls) {
        errors.push(
          `Week of ${week.weekStart.toLocaleDateString()} exceeds call limit. ` +
            `Maximum ${week.maxCalls} calls per week, but ${totalCallsForWeek} calls are scheduled.`,
        );
      }

      if (week.existingCalls >= week.maxCalls && week.proposedCalls === 0) {
        warnings.push(
          `Week of ${week.weekStart.toLocaleDateString()} is fully booked. ` +
            `${week.existingCalls}/${week.maxCalls} calls scheduled.`,
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Gets available weeks for scheduling new calls
   */
  async getAvailableWeeksForSubscription(
    subscriptionId: string,
  ): Promise<WeeklyCallInfo[]> {
    const validationResult = await this.validateSubscriptionSlots(
      subscriptionId,
      [],
    );
    return validationResult.weeklyInfo.filter((week) => week.canScheduleMore);
  }

  /**
   * Checks if a specific week can accommodate additional calls
   */
  async canScheduleInWeek(
    subscriptionId: string,
    weekDate: Date,
    additionalCalls: number = 1,
  ): Promise<boolean> {
    const validationResult = await this.validateSubscriptionSlots(
      subscriptionId,
      [],
    );

    // Containment match (weeks are scheduling-timezone ranges, ADR B9)
    const weekInfo = validationResult.weeklyInfo.find(
      (week) => week.weekStart <= weekDate && weekDate <= week.weekEnd,
    );

    return weekInfo ? weekInfo.availableSlots >= additionalCalls : false;
  }
}

/**
 * Helper function to get the week that contains a specific date within a
 * subscription period. Weeks are scheduling-timezone Sundays (ADR B9).
 */
export function getSubscriptionWeek(
  targetDate: Date,
  subscriptionStartDate: Date,
  schedulingTimezone?: string,
): number {
  const weekStart = SlotCalculationService.startOfWeekSundayInTz(
    subscriptionStartDate,
    schedulingTimezone,
  );
  const targetWeekStart = SlotCalculationService.startOfWeekSundayInTz(
    targetDate,
    schedulingTimezone,
  );

  const diffInWeeks = Math.round(
    (targetWeekStart.getTime() - weekStart.getTime()) /
      (7 * 24 * 60 * 60 * 1000),
  );

  return diffInWeeks + 1; // 1-based week numbering
}

/**
 * Helper function to determine subscription type based on plan details
 */
export function getSubscriptionType(
  sessionsPerWeek: number,
  durationInMonths: number,
): string {
  if (sessionsPerWeek === 1 && durationInMonths === 1) {
    return "Basic";
  } else if (sessionsPerWeek === 2 && durationInMonths === 2) {
    return "Extended";
  } else if (sessionsPerWeek === 3 && durationInMonths === 6) {
    return "Comprehensive";
  }
  return "Custom";
}
