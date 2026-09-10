/**
 * #626/#627 — "this offering already has paying bookings, so its times are
 * frozen; use the reschedule workflow".
 *
 * A typed error rather than an early `NextResponse` because the guard now runs
 * INSIDE the scheduling transaction: the pre-transaction version read the
 * payment count and then committed the time change, so a checkout's Payment
 * could land in between and the booking's time moved under it anyway.
 */
export class ScheduleLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleLockedError";
  }
}

export const WEBINAR_TIME_LOCKED_MESSAGE =
  "Cannot reschedule a webinar with confirmed bookings. Use the reschedule workflow instead.";

export const CLASS_SCHEDULE_LOCKED_MESSAGE =
  "Cannot modify class schedule with enrolled participants. Use the reschedule workflow instead.";
