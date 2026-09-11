import { z } from "zod";

export const ReviewVerificationSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "NEEDS_INFO"]),
  reviewNotes: z.string().optional(),
  rejectionReason: z.string().optional(),
  feedbackDetails: z.string().optional(),
  documentFeedback: z
    .array(
      z.object({
        documentId: z.string(),
        isValid: z.boolean(),
        staffFeedback: z.string().optional(),
      }),
    )
    .optional(),
});
