/**
 * One reading of a planner event's archive state (#1494).
 *
 * `EventCarousel` decides the `archived` value the PATCH sends and `EventCard`
 * renders the "Archived" badge from the same fact, so a second copy of this
 * derivation lets the badge and the toggle disagree about one plan.
 *
 * `archivedAt` lives on the plan, not on the session instance, so each branch
 * reads the nested plan rather than the event itself.
 */

import {
  ClassEvent,
  ConsultationPlanEvent,
  Event,
  SubscriptionPlanEvent,
  WebinarEvent,
} from "@/types/planner-events";

export function isWebinarEvent(event: Event): event is WebinarEvent {
  return event.type === "webinar";
}

export function isClassEvent(event: Event): event is ClassEvent {
  return event.type === "class";
}

export function isConsultationPlanEvent(
  event: Event,
): event is ConsultationPlanEvent {
  return event.type === "consultation";
}

export function isSubscriptionPlanEvent(
  event: Event,
): event is SubscriptionPlanEvent {
  return event.type === "subscription";
}

export function getPlanArchivedAt(event: Event): Date | null {
  if (isWebinarEvent(event)) return event.webinarPlan.archivedAt ?? null;
  if (isClassEvent(event)) return event.classPlan.archivedAt ?? null;
  if (isConsultationPlanEvent(event))
    return event.consultationPlan.archivedAt ?? null;
  if (isSubscriptionPlanEvent(event))
    return event.subscriptionPlan.archivedAt ?? null;
  return null;
}

// The plan is the sellable offering; for webinar/class events `event.id` names
// the SESSION instance, so the plan id must be read from the nested plan.
export function getPlanId(event: Event): string | undefined {
  if (isWebinarEvent(event)) return event.webinarPlan.id;
  if (isClassEvent(event)) return event.classPlan.id;
  if (isConsultationPlanEvent(event)) return event.consultationPlan.id;
  if (isSubscriptionPlanEvent(event)) return event.subscriptionPlan.id;
  return undefined;
}
