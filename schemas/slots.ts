import { z } from "zod";

export const RequestForApprovalSchema = z
  .object({
    consultantProfileId: z.string().min(1, "Consultant profile ID is required"),
    startsAt: z.string().min(1, "Slot start time is required"),
    endsAt: z.string().min(1, "Slot end time is required"),
    consultationPlanId: z.string().min(1, "Consultation plan ID is required"),
    slotOfAvailabilityWeeklyId: z.string().optional(),
    slotOfAvailabilityCustomId: z.string().optional(),
    // #1166 ORG-9 — an org member may request a sponsored booking; validated
    // against an ACTIVE membership of a canSponsor org in the route. min(1)
    // because "" would skip that check and then be written as the FK.
    organizationId: z.string().min(1).optional(),
  })
  .refine(
    (data) =>
      !(data.slotOfAvailabilityWeeklyId && data.slotOfAvailabilityCustomId),
    {
      message: "Cannot provide both weekly and custom slot availability IDs",
      path: ["slotOfAvailabilityWeeklyId"],
    },
  )
  .refine(
    (data) =>
      data.slotOfAvailabilityWeeklyId || data.slotOfAvailabilityCustomId,
    {
      message: "Must provide either weekly or custom slot availability ID",
      path: ["slotOfAvailabilityWeeklyId"],
    },
  )
  .refine(
    (data) => {
      const start = new Date(data.startsAt);
      const end = new Date(data.endsAt);
      return !isNaN(start.getTime()) && !isNaN(end.getTime());
    },
    {
      message: "Invalid date format",
      path: ["startsAt"],
    },
  )
  .refine(
    (data) => {
      const start = new Date(data.startsAt);
      const end = new Date(data.endsAt);
      return start < end;
    },
    {
      message: "Start time must be before end time",
      path: ["startsAt"],
    },
  );
