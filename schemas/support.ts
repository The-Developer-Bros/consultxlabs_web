import { z } from "zod";
import {
  SupportTicketStatusEnum,
  SupportPriorityEnum,
  SupportIssueTypeEnum,
} from "./enums";
import {
  MAX_SHORT_FIELD_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
} from "@/lib/validation/limits";

// #831 — every user-typed string carries a .max()
export const CreateSupportTicketSchema = z.object({
  title: z.string().min(1, "Title is required").max(MAX_TITLE_LENGTH),
  description: z
    .string()
    .min(1, "Description is required")
    .max(MAX_TEXT_LENGTH),
  priority: SupportPriorityEnum.optional(),
  category: z.string().max(MAX_SHORT_FIELD_LENGTH).optional(),
  issueType: SupportIssueTypeEnum.optional(),
  consultationId: z.string().optional(),
  subscriptionId: z.string().optional(),
  paymentId: z.string().optional(),
  appointmentId: z.string().optional(),
});

export const UpdateSupportTicketSchema = z.object({
  status: SupportTicketStatusEnum.optional(),
  priority: SupportPriorityEnum.optional(),
  assignedToId: z.string().nullable().optional(),
  refundId: z.string().optional(),
});

export const CreateSupportResponseSchema = z.object({
  message: z.string().trim().min(1, "Message is required").max(MAX_TEXT_LENGTH),
  isInternal: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Route param schemas — the ONE definition of "what an id looks like" for the
// support surface. Deliberately NOT .uuid()/.cuid(): ids are opaque strings
// (uuid in prod, readable slugs like `demo0813-apt-ba` in seeds), and the DB
// lookup is the real validator — a format check here only produced 400s that
// looked like data bugs. Length-bounded so garbage can't reach Prisma.
// ---------------------------------------------------------------------------

export const AppointmentIdParams = z.object({
  appointmentId: z.string().min(1).max(64),
});

export const SupportThreadIdParams = z.object({
  threadId: z.string().min(1).max(64),
});

export const OrgIdParams = z.object({
  orgId: z.string().min(1).max(64),
});
