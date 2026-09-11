/**
 * Resolves the scheduling timezone stamped onto a Subscription or Class at
 * creation time.
 *
 * #1076 — the column has always existed with a `Asia/Kolkata` default and no
 * writer, so every per-day/per-week cap on the platform bucketed against
 * Indian calendar days no matter where the consultant was. A cap is a
 * statement about the *consultant's* workload, so it has to bucket on the
 * consultant's day boundaries.
 *
 * The source is `User.timezone` on the owning consultant rather than
 * `SlotOfAvailabilityWeekly.timezone`: the latter is nullable, deliberately
 * left unwritten until the post-MVP DST work (#872), and is per-availability-
 * row, so several rows could disagree with no rule for picking between them.
 * `User.timezone` is one value per consultant and is actually written today,
 * by onboarding and by the profile editor.
 */
import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";

/** A junk zone here silently corrupts every cap for the booking, so gate it. */
export function isValidIanaTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The consultant's zone when it is recorded and real, otherwise the platform
 * default — an unset or invalid zone leaves that consultant's behaviour
 * exactly as it is today.
 */
export function resolveSchedulingTimezone(
  consultantTimezone: string | null | undefined,
): string {
  const timezone = consultantTimezone?.trim();
  if (!timezone || !isValidIanaTimezone(timezone)) {
    return SlotCalculationService.DEFAULT_SCHEDULING_TIMEZONE;
  }
  return timezone;
}
