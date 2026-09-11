/**
 * One SessionVM per SESSION, not per stored row (#1061).
 *
 * A booking is chunked into 30-minute `SlotOfAppointment` rows, and all three
 * appointment mappers used to emit one view-model per row. So a four-hour
 * consultation reached the list as eight half-hour sessions and rendered as
 * the first of them — "2:00 PM – 2:30 PM" for a booking that runs until 4:30
 * — while the Manage Timings grid, which groups properly, drew the same
 * booking as one continuous run. This is the display half of the confusion
 * #1061 describes; the room-identity and join-state halves were fixed without
 * it, and the mappers each carried their own copy of the wrong rule.
 *
 * Lives in its own module rather than in `view-model.ts` because `slots.ts`
 * already imports that file, and pulling `groupSlotsIntoRuns` the other way
 * would close the cycle.
 *
 * See docs/booking/03-slot-math-and-calculations.md for the invariant this
 * enforces and why the contiguity walk cannot be reduced to an appointment id.
 */

import { groupSlotsIntoRuns, isDeadSlot } from "./slots";
import {
  sortSessions,
  toSessionVM,
  type SessionVM,
  type SlotLike,
} from "./view-model";

export interface SessionSourceAppointment {
  id: string;
  slotsOfAppointment?: SlotLike[] | null;
}

/**
 * Group one appointment's rows into sessions.
 *
 * `groupSlotsIntoRuns` is the single definition of what one session is, so
 * this calls it rather than walking rows itself. It drops cancelled and
 * rescheduled rows, which is right for joining and wrong for a timeline that
 * still has to show a session was cancelled — hence the bucketing below,
 * which puts dead rows through the same helper with their status masked so it
 * cannot filter them out. Bucketing by status FIRST is what stops a cancelled
 * row bridging two live runs that are not actually contiguous.
 */
export function sessionsOfAppointment(
  appointment: SessionSourceAppointment | null | undefined,
): SessionVM[] {
  const rows: SlotLike[] = (appointment?.slotsOfAppointment ?? []).map(
    (slot) => ({ ...slot, appointmentId: appointment?.id ?? null }),
  );

  const buckets = new Map<string, SlotLike[]>();
  for (const row of rows) {
    const key = isDeadSlot(row) ? `dead:${row.completionStatus}` : "live";
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  return sortSessions(
    [...buckets.values()].flatMap((bucket) =>
      groupSlotsIntoRuns(
        bucket.map((row) => ({ ...row, completionStatus: null })),
      ).map((run) => {
        // Everything except the bounds comes from the ANCHOR's real row. The
        // MeetingSession hangs off the anchor by construction (#1061), so no
        // other row can report that the host ended the call; `isTentative` and
        // deadness are uniform across a run because the grouper splits on the
        // first and the bucketing above splits on the second.
        const anchor = byId.get(run.anchor.id) ?? run.anchor;
        return {
          ...toSessionVM(anchor),
          startsAt: run.startsAt,
          endsAt: run.endsAt,
        };
      }),
    ),
  );
}
