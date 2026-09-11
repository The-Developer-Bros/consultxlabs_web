import {
  TConsultationWithPlan,
  TSubscriptionWithPlan,
  TWebinarWithPlan,
  TClassWithPlan,
} from "@/hooks/useEvents";

export type EventWithType =
  | (TConsultationWithPlan & { type: "Consultation" })
  | (TSubscriptionWithPlan & { type: "Subscription" })
  | (TWebinarWithPlan & { type: "Webinar" })
  | (TClassWithPlan & { type: "Class" });

export function getEventTitle(event: EventWithType): string {
  switch (event.type) {
    case "Consultation":
      return event.consultationPlan.title;
    case "Subscription":
      return event.subscriptionPlan.title;
    case "Webinar":
      return event.webinarPlan.title;
    case "Class":
      return event.classPlan.title;
    default:
      return "Unknown Event";
  }
}

export function getConsultantName(event: EventWithType): string {
  switch (event.type) {
    case "Consultation":
      return (
        event.consultationPlan.consultantProfile?.user?.name ||
        "Unknown Consultant"
      );
    case "Subscription":
      return (
        event.subscriptionPlan.consultantProfile?.user?.name ||
        "Unknown Consultant"
      );
    case "Webinar":
      return (
        event.webinarPlan.consultantProfile?.user?.name || "Unknown Consultant"
      );
    case "Class":
      return (
        event.classPlan.consultantProfile?.user?.name || "Unknown Consultant"
      );
    default:
      return "Unknown Consultant";
  }
}

export function getConsultantImage(event: EventWithType): string | null {
  switch (event.type) {
    case "Consultation":
      return event.consultationPlan.consultantProfile?.user?.image || null;
    case "Subscription":
      return event.subscriptionPlan.consultantProfile?.user?.image || null;
    case "Webinar":
      return event.webinarPlan.consultantProfile?.user?.image || null;
    case "Class":
      return event.classPlan.consultantProfile?.user?.image || null;
    default:
      return null;
  }
}

export function getConsultantInitial(event: EventWithType): string {
  const name = getConsultantName(event);
  return name.charAt(0) || "?";
}

export function formatDate(date: Date | null | undefined): string {
  if (!date) return "Date not set";
  return new Date(date).toLocaleDateString();
}

export function getEventEndDate(event: EventWithType): Date | null {
  switch (event.type) {
    case "Subscription":
      return event.schedulingPeriodEndsAt;
    case "Class":
      return event.schedulingPeriodEndsAt;
    default:
      return null;
  }
}

export function isRecurringEvent(event: EventWithType): boolean {
  return event.type === "Subscription" || event.type === "Class";
}

export function getRecurringEvents(events: EventWithType[]): EventWithType[] {
  return events.filter(isRecurringEvent);
}

export function getEventStatus(event: EventWithType): string {
  switch (event.type) {
    case "Consultation":
      return event.status || "Unknown";
    case "Subscription":
      return event.status || "Unknown";
    case "Webinar":
      return event.status || "Unknown";
    case "Class":
      return event.status || "Unknown";
  }
  return "Unknown";
}

export function getStatusColor(status: string): string {
  if (!status) {
    return "bg-gray-50 text-gray-700";
  }
  const statusLower = status.toLowerCase();
  if (statusLower === "completed") return "bg-green-50 text-green-700";
  if (statusLower === "rejected") return "bg-red-50 text-red-700";
  if (statusLower === "pending") return "bg-yellow-50 text-yellow-700";
  return "bg-gray-50 text-gray-700";
}
