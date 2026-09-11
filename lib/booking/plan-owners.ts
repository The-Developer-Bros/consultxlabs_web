/**
 * Who may act on a booking as its consultant.
 *
 * This was written out by hand at every route that needed it, and the copies
 * drifted: the manage-timings read omitted `trialSession`, so a consultant
 * opening the timings of their own trial was refused by a check the reschedule
 * route passed. Two hand-maintained ownership predicates is one too many —
 * the failure mode is silent, and it is an authorization decision.
 *
 * Collaborators count only for webinars and classes. Consultation and
 * subscription plans have no collaborator relation on this read, and widening
 * the set here would grant access the other surfaces do not.
 */

interface PlanOwner {
  consultantProfile?: { id: string } | null;
}

interface PlanWithCollaborators extends PlanOwner {
  collaborators?: { consultantProfile?: { id: string } | null }[] | null;
}

export interface AppointmentPlanOwnership {
  consultation?: { consultationPlan?: PlanOwner | null } | null;
  subscription?: { subscriptionPlan?: PlanOwner | null } | null;
  webinar?: { webinarPlan?: PlanWithCollaborators | null } | null;
  class?: { classPlan?: PlanWithCollaborators | null } | null;
  trialSession?: { subscriptionPlan?: PlanOwner | null } | null;
}

export function resolvePlanOwnerIds(
  appointment: AppointmentPlanOwnership,
): string[] {
  return [
    appointment.consultation?.consultationPlan?.consultantProfile?.id,
    appointment.subscription?.subscriptionPlan?.consultantProfile?.id,
    appointment.webinar?.webinarPlan?.consultantProfile?.id,
    appointment.class?.classPlan?.consultantProfile?.id,
    appointment.trialSession?.subscriptionPlan?.consultantProfile?.id,
    ...(appointment.webinar?.webinarPlan?.collaborators ?? []).map(
      (collaborator) => collaborator.consultantProfile?.id,
    ),
    ...(appointment.class?.classPlan?.collaborators ?? []).map(
      (collaborator) => collaborator.consultantProfile?.id,
    ),
  ].filter((id): id is string => Boolean(id));
}
