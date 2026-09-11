import { z } from "zod";
import { TrialSessionStatusEnum } from "./enums";
import { MAX_TEXT_LENGTH } from "@/lib/validation/limits";

export const CreateTrialSchema = z.object({
  consulteeProfileId: z.string().min(1, "Consultee profile ID is required"),
  consultantProfileId: z.string().min(1, "Consultant profile ID is required"),
  subscriptionPlanId: z.string().min(1, "Subscription plan ID is required"),
  notes: z.string().max(MAX_TEXT_LENGTH).optional(), // #831
  // Enterprise (arch-4) — optional org attribution. When the booker is a
  // LEARNER of an org, passing the orgId here stamps the trial with
  // `TrialSession.organizationId` so analytics can segment org-tagged
  // trials from organic ones and measure conversion. The org pays
  // nothing — this is *attribution*, not sponsorship. Membership is
  // verified server-side before persisting.
  organizationId: z.string().optional(),
});

export const UpdateTrialSchema = z.object({
  status: TrialSessionStatusEnum.optional(),
  scheduledTime: z.string().optional(),
  slotData: z
    .object({
      startsAt: z.string(),
      endsAt: z.string(),
      slotOfAvailabilityId: z.string(),
      slotType: z.enum(["WEEKLY", "CUSTOM"]),
    })
    .optional(),
  notes: z.string().max(MAX_TEXT_LENGTH).optional(), // #831
  // Required when status = CONVERTED — the subscription created via checkout
  subscriptionId: z.string().optional(),
});
