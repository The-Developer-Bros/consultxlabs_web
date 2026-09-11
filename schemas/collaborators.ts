import { z } from "zod";
import { CollaboratorRole } from "@prisma/client";

// #784 — one DB enum, but each plan type still only accepts its own role
// subset (the old per-type enums enforced this at the DB layer).
export const WEBINAR_COLLABORATOR_ROLES = [
  CollaboratorRole.CO_HOST,
  CollaboratorRole.MODERATOR,
  CollaboratorRole.GUEST_SPEAKER,
  CollaboratorRole.TECHNICAL_SUPPORT,
] as const;

export const CLASS_COLLABORATOR_ROLES = [
  CollaboratorRole.CO_INSTRUCTOR,
  CollaboratorRole.TEACHING_ASSISTANT,
  CollaboratorRole.GUEST_LECTURER,
  CollaboratorRole.CONTENT_CREATOR,
] as const;

export const WebinarCollaboratorRoleEnum = z.enum(WEBINAR_COLLABORATOR_ROLES);
export const ClassCollaboratorRoleEnum = z.enum(CLASS_COLLABORATOR_ROLES);

// #768 lockdown #12 — typed permission booleans set at invite time. Default
// false (least privilege); the owner opts each capability in per collaborator.
export const collaboratorPermissionsSchema = z.object({
  canApprovePayment: z.boolean().optional().default(false),
  canViewAnalytics: z.boolean().optional().default(false),
  canEditEvent: z.boolean().optional().default(false),
  canSeeAttendees: z.boolean().optional().default(false),
});

export type CollaboratorPermissions = z.infer<
  typeof collaboratorPermissionsSchema
>;

export const inviteCollaboratorSchema = z
  .object({
    consultantProfileId: z.string().min(1, "Consultant profile ID is required"),
    revenueSharePercentage: z
      .number({ required_error: "Revenue share percentage is required" })
      .gt(0, "Revenue share percentage must be greater than 0")
      .lte(90, "Revenue share percentage cannot exceed 90"),
  })
  .merge(collaboratorPermissionsSchema);

export const inviteWebinarCollaboratorSchema = inviteCollaboratorSchema.extend({
  role: WebinarCollaboratorRoleEnum,
});

export const inviteClassCollaboratorSchema = inviteCollaboratorSchema.extend({
  role: ClassCollaboratorRoleEnum,
});
