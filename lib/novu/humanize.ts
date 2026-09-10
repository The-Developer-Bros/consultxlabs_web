/**
 * Customer-ready values for Novu payloads (#536).
 *
 * The Novu templates live in the dashboard and interpolate payload fields
 * verbatim — `{{payload.dateTime}}`, `{{payload.amount}}`, `{{payload.planTitle}}`.
 * Whatever this repository puts in those fields is what a customer reads, so a
 * raw ISO timestamp, an integer count of paise or a shouted enum lands in the
 * inbox exactly as stored. These helpers are the single place that turns the
 * stored value into the sentence fragment the template needs.
 *
 * The naming rule the whole payload layer follows: a template interpolates the
 * unit-free field name and gets a human value; the raw value keeps the same
 * stem with a unit suffix (`dateTimeIso`, `amountPaise`, `appointmentTypeCode`)
 * for any consumer that has to compute or branch on it.
 */

import type { CancellationReason } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  formatCurrencyAmount,
  formatCurrencyAmountBare,
} from "@/utils/formatting";

/** The platform's home zone, used whenever a recipient has none recorded. */
export const DEFAULT_NOTIFICATION_TIMEZONE = "Asia/Kolkata";

/**
 * CLDR carries no English abbreviation for these zones, so Intl's `short`
 * time-zone name renders "GMT+5:30". #536 — the platform's primary market
 * reads that as noise; they know the zone as IST. Everywhere else Intl's own
 * abbreviation (EDT, AEST, …) is both correct and unambiguous, so only the
 * zones this platform actually defaults to are overridden here.
 */
const ZONE_ABBREVIATION: Record<string, string> = {
  "Asia/Kolkata": "IST",
  "Asia/Calcutta": "IST",
};

/** A junk zone throws inside Intl, which would turn a notification into a 500. */
function isRenderableTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone a notification should be rendered in: the recipient's own when it
 * is recorded and valid, the platform default otherwise.
 */
export function resolveNotificationTimezone(
  timezone: string | null | undefined,
): string {
  const candidate = timezone?.trim();
  if (!candidate || !isRenderableTimezone(candidate)) {
    return DEFAULT_NOTIFICATION_TIMEZONE;
  }
  return candidate;
}

/**
 * Render an instant as `Sat, 6 Sep 2026 · 7:53 AM IST`.
 *
 * The parts are assembled by hand rather than taken from a single `format()`
 * call because no locale produces this order: `en-US` gives the month before
 * the day, and `en-GB` gives a lower-case meridiem and "Sept". Assembling from
 * `formatToParts` keeps one house format across every locale-independent
 * notification.
 */
export function formatNotificationDateTime(
  value: string | Date | null | undefined,
  timezone?: string | null,
): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;

  const zone = resolveNotificationTimezone(timezone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(date);

  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  const zoneLabel = ZONE_ABBREVIATION[zone] ?? part("timeZoneName");
  const day = `${part("weekday")}, ${part("day")} ${part("month")} ${part("year")}`;
  const time = `${part("hour")}:${part("minute")} ${part("dayPeriod")}`;
  return `${day} · ${time} ${zoneLabel}`.trim();
}

/**
 * Render an amount held in the smallest currency unit as money — `₹55,679.48`
 * rather than `5567948`. Delegates to the platform's one paise-taking
 * formatter so the notification layer cannot drift from every other surface.
 */
export function formatNotificationMoney(
  amountInSmallestUnit: number | bigint,
  currency: string,
): string {
  return formatCurrencyAmount(Number(amountInSmallestUnit), currency);
}

/**
 * The same amount with the symbol or code stripped: `55,679.48`.
 *
 * Four live in-app templates — `payment-success`, `payment-failed`,
 * `refund-processed` and `refund-requested` — render `{{currency}} {{amount}}`,
 * and the Novu plan in use cannot edit them today. A symbol-bearing `amount`
 * would read "INR ₹55,679.48" there, so those four send the bare figure and let
 * the template supply the ISO code it already prints (#536). Their payloads
 * also carry `amountFormatted` with the symbol, for whichever template is
 * written next.
 */
export function formatNotificationAmountBare(
  amountInSmallestUnit: number | bigint,
  currency: string,
): string {
  return formatCurrencyAmountBare(Number(amountInSmallestUnit), currency);
}

/**
 * Who cancelled, written as a noun a sentence can use.
 *
 * The live `appointment-cancelled` template OPENS its sentence with this value
 * — "{{cancelledBy}} cancelled the {{appointmentType}} session for
 * {{planTitle}}" — so every branch is capitalised; a person's name already is.
 *
 * One payload reaches BOTH parties, which is why the field names the person
 * rather than describing them: "Your consultant" would be false for the
 * consultant reading their own copy. The role-relative strings survive only as
 * fallbacks for a record whose name is missing (#536).
 */
export function cancelledByLabel(
  cancelledBy: "consultant" | "consultee" | "system",
  names: { consultantName?: string | null; consulteeName?: string | null },
): string {
  if (cancelledBy === "consultant") {
    return names.consultantName?.trim() || "Your consultant";
  }
  if (cancelledBy === "consultee") {
    return names.consulteeName?.trim() || "The participant";
  }
  return "The platform";
}

/**
 * Why it was cancelled, as a clause that can follow "Reason: ".
 *
 * The live template ends on `Reason: {{reason}}`, so an absent value left the
 * sentence hanging on a colon and a raw `CancellationReason` member shouted
 * `MODERATION` at the person it had just been used against (#536). Callers pass
 * three different things — a member of the enum, free text a user typed, or
 * nothing at all — and all three have to come out as a readable clause.
 *
 * The table is exhaustive over the enum on purpose: a reason added to the
 * schema without copy here should fail the build rather than reach an inbox as
 * its own identifier.
 */
const CANCELLATION_REASON_LABEL: Record<CancellationReason, string> = {
  SCHEDULE_CONFLICT: "a scheduling conflict",
  FOUND_ALTERNATIVE: "an alternative was arranged",
  FINANCIAL_REASONS: "financial reasons",
  PERSONAL_EMERGENCY: "a personal emergency",
  NO_LONGER_NEEDED: "the session was no longer needed",
  CONSULTANT_UNAVAILABLE: "the consultant was unavailable",
  CONSULTANT_EMERGENCY: "an emergency on the consultant's side",
  PAYMENT_FAILED: "the payment did not go through",
  EXPIRED: "the booking expired before it was confirmed",
  CONSULTANT_ISSUE: "an issue on the consultant's side",
  TECHNICAL_ISSUE: "a technical issue",
  MODERATION: "a moderation decision on this account",
  OTHER: "a reason the other party did not specify",
};

export function cancellationReasonLabel(
  reason: string | null | undefined,
): string {
  const raw = reason?.trim();
  if (!raw) return "No reason given";
  const key = raw.toUpperCase().replace(/[\s-]+/g, "_");
  // Free text a user typed is returned verbatim; only an exact enum member is
  // rewritten, so a sentence that happens to contain a member's words survives.
  return CANCELLATION_REASON_LABEL[key as CancellationReason] ?? raw;
}

/**
 * Sentence-case labels for `AppointmentsType`. The templates read
 * "Your {{payload.appointmentType}} … has been booked", so the value has to be
 * a noun phrase that fits mid-sentence — `SUBSCRIPTION` does not.
 *
 * The input is normalised first because callers reach this from two directions:
 * the Prisma enum (`SUBSCRIPTION`) at the payment and trial sites, and an
 * already-lower-case literal (`"subscription"`) at the reminder and reschedule
 * sites. Both must produce the same label.
 */
const APPOINTMENT_TYPE_LABEL: Record<string, string> = {
  CONSULTATION: "consultation",
  SUBSCRIPTION: "subscription session",
  WEBINAR: "webinar",
  CLASS: "class",
  TRIAL: "trial session",
};

export function appointmentTypeLabel(
  appointmentType: string | null | undefined,
): string {
  const raw = appointmentType?.trim();
  if (!raw) return "session";
  const key = raw.toUpperCase().replace(/[\s-]+/g, "_");
  return APPOINTMENT_TYPE_LABEL[key] ?? key.toLowerCase().replace(/_/g, " ");
}

/**
 * The name to print when the plan row behind a notification is gone.
 *
 * Three cancellation paths sent `planTitle: "N/A"` and one reschedule path sent
 * `"Unknown"` (#536). Those are placeholders a developer reads in a log, and
 * they arrived in the inbox as the name of the thing the customer had just lost
 * — "your session \"N/A\" has been cancelled". The session label is not the
 * plan's name, but it is at least true and reads as English.
 */
export function planTitleOrSessionLabel(
  planTitle: string | null | undefined,
  appointmentType: string | null | undefined,
): string {
  const title = planTitle?.trim();
  if (title) return title;
  const label = appointmentTypeLabel(appointmentType);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * How long the recipient-timezone read may take before the send proceeds on the
 * default zone.
 *
 * A notification must never be the thing that hangs a request. `PG_POOL_MAX=1`
 * on Netlify means this read waits behind whatever else holds the connection,
 * and a caller that triggers from inside a transaction would otherwise wait for
 * a connection its own transaction is holding. Abandoning the wait degrades one
 * notification to the platform zone; blocking would degrade the request.
 */
const TIMEZONE_LOOKUP_TIMEOUT_MS = 2_000;

/**
 * Load the recipients' zones in one query, keyed by user id.
 *
 * `triggerForMultiple` sends one payload to several subscribers, so a single
 * rendered date would be right for at most one of them. Callers group by the
 * value this returns and send one payload per distinct zone.
 *
 * Never throws and never blocks for long: on any failure every recipient falls
 * back to the platform default, which is the behaviour this layer had before
 * #536 anyway.
 */
export async function resolveRecipientTimezones(
  userIds: string[],
): Promise<Map<string, string>> {
  const zones = new Map<string, string>();
  const unique = Array.from(new Set(userIds));
  for (const id of unique) zones.set(id, DEFAULT_NOTIFICATION_TIMEZONE);
  if (unique.length === 0) return zones;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const users = await Promise.race([
      prisma.user.findMany({
        where: { id: { in: unique } },
        select: { id: true, timezone: true },
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TIMEZONE_LOOKUP_TIMEOUT_MS);
      }),
    ]);
    if (!users) return zones;
    for (const user of users) {
      zones.set(user.id, resolveNotificationTimezone(user.timezone));
    }
  } catch {
    // Zones stay at the platform default — a notification is never worth an
    // exception, and the caller has already been told nothing about the read.
  } finally {
    // The losing timer would otherwise keep the event loop busy for up to two
    // seconds after a fast read.
    if (timer) clearTimeout(timer);
  }

  return zones;
}

/** Recipients bucketed by the zone their payload must be rendered in. */
export function groupRecipientsByTimezone(
  userIds: string[],
  zones: Map<string, string>,
): Map<string, string[]> {
  const buckets = new Map<string, string[]>();
  for (const id of userIds) {
    const zone = zones.get(id) ?? DEFAULT_NOTIFICATION_TIMEZONE;
    const bucket = buckets.get(zone);
    if (bucket) bucket.push(id);
    else buckets.set(zone, [id]);
  }
  return buckets;
}
