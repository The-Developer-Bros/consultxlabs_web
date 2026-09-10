/**
 * The one place a weekly availability row's `utcOffsetMinutes` is decided
 * (#1326, #1348).
 *
 * Four write paths used to answer this question for themselves and two of them
 * answered it wrong: onboarding stored `0` for a consultant with no profile
 * timezone, as did the per-row PATCH, so every row they wrote projected as if
 * the consultant lived in UTC and the grid drew their availability five and a
 * half hours away from where they published it. Nothing validated a caller who
 * sent an offset of their own either, so a client could contradict the profile
 * silently.
 *
 * The rule: the consultant's `User.timezone` is the source, a caller-supplied
 * value may only agree with it, and an absent or unusable zone falls back to
 * the launch offset rather than to UTC (ADR 17 — IST-only at launch).
 */

import { getTimezoneOffsetMinutes } from "@/utils/slotAllocation/slotTimeUtils";
import { reportSentryMessage } from "@/lib/observability/report";

export { weeklyRowLocalColumns } from "@/utils/schedule/weekly-projection";
export type { WeeklyRowLocalColumns } from "@/utils/schedule/weekly-projection";

/** IST. The platform's only market at launch (ADR 17). */
export const LAUNCH_UTC_OFFSET_MINUTES = 330;
export const LAUNCH_TIMEZONE = "Asia/Kolkata";

/**
 * The single switch that turns the rule into "hard-pin every row to IST".
 * Flip it to true if a consultant's profile zone ever has to stop deciding
 * their availability offset; nothing else changes.
 */
const PIN_TO_LAUNCH_OFFSET: boolean = false;

/**
 * Zones whose real offset IS zero. `getTimezoneOffsetMinutes` answers 0 both
 * for these and for anything it cannot resolve, so without this set a typo
 * would be indistinguishable from Greenwich and would be stored as UTC.
 */
const ZERO_OFFSET_ZONES = new Set(["UTC", "Etc/UTC", "GMT", "Etc/GMT"]);

export const WEEKLY_OFFSET_CONFLICT_CODE = "UTC_OFFSET_CONFLICT";

/** A caller sent a `utcOffsetMinutes` that contradicts the profile zone. */
export class WeeklyOffsetConflictError extends Error {
  readonly code = WEEKLY_OFFSET_CONFLICT_CODE;

  constructor(
    readonly suppliedOffsetMinutes: number,
    readonly resolvedOffsetMinutes: number,
  ) {
    super(
      `utcOffsetMinutes ${suppliedOffsetMinutes} contradicts the consultant's profile timezone (${resolvedOffsetMinutes})`,
    );
    this.name = "WeeklyOffsetConflictError";
  }
}

function normaliseZone(profileTimezone: string | null | undefined): string {
  return profileTimezone?.trim() ?? "";
}

/** The zone's offset, or null when the zone is unset or unresolvable. */
function derivedOffsetMinutes(zone: string): number | null {
  if (!zone) return null;
  const offset = getTimezoneOffsetMinutes(zone);
  if (offset !== 0) return offset;
  return ZERO_OFFSET_ZONES.has(zone) ? 0 : null;
}

/**
 * The IANA zone stamped onto the row's `timezone` column: the consultant's own
 * when it resolves, the launch zone otherwise.
 */
export function resolveWeeklyTimezone(
  profileTimezone: string | null | undefined,
): string {
  const zone = normaliseZone(profileTimezone);
  return derivedOffsetMinutes(zone) === null ? LAUNCH_TIMEZONE : zone;
}

export interface ResolveWeeklyOffsetInput {
  /** `User.timezone` of the consultant who owns the rows. */
  profileTimezone: string | null | undefined;
  /** What the request body asked for, if anything. May only agree. */
  callerSupplied?: number | null;
  /** For the drift warning only. */
  consultantProfileId?: string;
}

/**
 * The offset every weekly row written in this request must carry.
 *
 * @throws WeeklyOffsetConflictError when `callerSupplied` disagrees; routes
 *         answer that with 400 `UTC_OFFSET_CONFLICT`.
 */
export function resolveWeeklyUtcOffsetMinutes({
  profileTimezone,
  callerSupplied,
  consultantProfileId,
}: ResolveWeeklyOffsetInput): number {
  const zone = normaliseZone(profileTimezone);
  const derived = derivedOffsetMinutes(zone);
  const resolved =
    PIN_TO_LAUNCH_OFFSET || derived === null
      ? LAUNCH_UTC_OFFSET_MINUTES
      : derived;

  if (
    callerSupplied !== undefined &&
    callerSupplied !== null &&
    callerSupplied !== resolved
  ) {
    throw new WeeklyOffsetConflictError(callerSupplied, resolved);
  }

  // Once per write, never per row: a save rewrites the consultant's whole week
  // and this would otherwise fan out to one event per row. #872 rule 4 — the
  // frozen offset is only safe while everyone is on IST, so a consultant
  // publishing from anywhere else is the signal that the DST work is now due.
  if (zone && zone !== LAUNCH_TIMEZONE) {
    reportSentryMessage("weekly availability written outside Asia/Kolkata", {
      subsystem: "scheduling",
      op: "weekly-availability-write",
      expected: true,
      level: "warning",
      extra: {
        profileTimezone: zone,
        derivedOffsetMinutes: derived,
        resolvedOffsetMinutes: resolved,
        consultantProfileId,
      },
    });
  }

  return resolved;
}
