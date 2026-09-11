import { z } from "zod";
import { CancellationReasonEnum } from "./enums";

export const CancelAppointmentSchema = z.object({
  reason: CancellationReasonEnum.optional(),
  notes: z.string().optional(),
});

/**
 * Optional proposal attached to a reschedule.
 *
 * Every field is optional: "release these slots, any time works" stays a valid
 * request, and it is the only shape group events accept. `.passthrough()`
 * because the same body also carries `slotIds`, which the route parses itself.
 */
/** ADR B1 — the calendar's atomic unit. */
const SLOT_MS = 30 * 60 * 1000;

export const RescheduleProposalSchema = z
  .object({
    proposedSlots: z
      .array(
        z
          .object({
            startsAt: z.string().datetime(),
            endsAt: z.string().datetime(),
          })
          // Exactly one atom per row, not merely "ends after it starts".
          // Auto-confirm hands the allocator `startsAt` alone, and manual mode
          // reads each string as ONE 30-minute start — so a 60-minute row is
          // silently booked as 30. The count check downstream still passes
          // (one row per released slot), which is what makes it invisible: the
          // consultee asks to move a 1-hour session and gets half of one.
          .refine(
            (s) => new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime() === SLOT_MS,
            { message: "Each proposed time must be exactly one 30-minute slot" },
          ),
      )
      .min(1)
      .max(64)
      .optional(),
    reason: z.string().trim().max(500).optional(),
    // #1065 — how to place the replacement when no concrete time is named.
    // Mirrors the Prisma enums; the allocator SCORES on these and never filters,
    // so an unmeetable preference costs a less-liked time and not the booking.
    preferredTimeOfDay: z.enum(["MORNING", "AFTERNOON", "EVENING"]).optional(),
    preferredDays: z.enum(["WEEKDAYS", "WEEKENDS"]).optional(),
  })
  .passthrough();
