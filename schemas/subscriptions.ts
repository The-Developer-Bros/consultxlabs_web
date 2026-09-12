import { z } from "zod";
import { RequestStatusEnum } from "./enums";
import { MAX_TEXT_LENGTH } from "@/lib/validation/limits";

export const UpdateSubscriptionStatusSchema = z.object({
  id: z.string().min(1, "Subscription ID is required"),
  status: RequestStatusEnum,
});

// #836 — status is NOT writable via PUT: status changes flow only
// through PATCH, where the allowed-from guard rides the WHERE clause.
export const UpdateSubscriptionSchema = z.object({
  schedulingPeriodStartsAt: z.string().optional(),
  schedulingPeriodEndsAt: z.string().optional(),
  requestNotes: z.string().max(MAX_TEXT_LENGTH).optional(), // #831
  planId: z.string().optional(),
});

export const PatchSubscriptionStatusSchema = z.object({
  status: RequestStatusEnum,
});
