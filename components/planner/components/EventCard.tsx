"use client";

import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Edit,
  Trash2,
  Clock,
  MessageSquare,
  CalendarRange,
  Video,
  GraduationCap,
  Users,
  Gift,
  Loader2,
  Archive,
  Undo2,
} from "lucide-react";
import { cn } from "@/utils/tailwind";
import { formatCurrencyAmount } from "@/utils/formatting";
import { isRecurringEventType } from "@/utils/slotAllocation/types";
import { effectiveMaxParticipants } from "@/lib/events/capacity";
import { WebinarStatus, ClassStatus } from "@prisma/client";
import { Event } from "@/types/planner-events";
import {
  getPlanArchivedAt,
  isClassEvent,
  isConsultationPlanEvent,
  isSubscriptionPlanEvent,
  isWebinarEvent,
} from "@/lib/planner/archive-state";

type EventType = "consultation" | "subscription" | "webinar" | "class";

interface EventCardProps {
  event: Event;
  eventType: EventType;
  participantCount: number;
  pendingTrialCount?: number;
  collaboratorRole?: string;
  isCollaborated?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  /**
   * False for a row carrying no id — both actions address the offering by id,
   * so neither has anything to act on. Defaults to true.
   */
  canManage?: boolean;
  onTrialsClick?: () => void;
  onJoinMeeting?: () => void;
  canJoinNow?: boolean;
  isJoiningMeeting?: boolean;
  /**
   * Archive/restore the offering this event's plan represents (#1494).
   * Omitted (rather than a no-op) for a row with no id, same as onEdit/onDelete.
   */
  onArchiveToggle?: () => void;
  isArchiveToggling?: boolean;
}

function formatCollaboratorRole(role: string): string {
  const labels: Record<string, string> = {
    HOST: "Host",
    CO_HOST: "Co-Host",
    MODERATOR: "Moderator",
    CO_INSTRUCTOR: "Co-Instructor",
    TEACHING_ASSISTANT: "TA",
  };
  return labels[role] || role;
}

const eventTypeConfig: Record<
  EventType,
  {
    icon: typeof MessageSquare;
    iconBg: string;
    iconColor: string;
    accent: string;
    label: string;
  }
> = {
  consultation: {
    icon: MessageSquare,
    iconBg: "bg-sky-50",
    iconColor: "text-sky-700",
    accent: "bg-sky-600",
    label: "Consultation",
  },
  subscription: {
    icon: CalendarRange,
    iconBg: "bg-teal-50",
    iconColor: "text-teal-700",
    accent: "bg-teal-600",
    label: "Subscription",
  },
  webinar: {
    icon: Video,
    iconBg: "bg-emerald-50",
    iconColor: "text-emerald-700",
    accent: "bg-emerald-600",
    label: "Webinar",
  },
  class: {
    icon: GraduationCap,
    iconBg: "bg-amber-50",
    iconColor: "text-amber-700",
    accent: "bg-amber-600",
    label: "Class",
  },
};

const formatCurrency = (price: number, currency: string) => {
  return formatCurrencyAmount(price, currency);
};

function getEventTitle(event: Event): string {
  if (isWebinarEvent(event)) return event.webinarPlan.title;
  if (isClassEvent(event)) return event.classPlan.title;
  if (isConsultationPlanEvent(event)) return event.consultationPlan.title;
  if (isSubscriptionPlanEvent(event)) return event.subscriptionPlan.title;
  return "";
}

function getEventDescription(event: Event): string {
  if (isWebinarEvent(event)) return event.webinarPlan.description ?? "";
  if (isClassEvent(event)) return event.classPlan.description ?? "";
  if (isConsultationPlanEvent(event))
    return event.consultationPlan.description ?? "";
  if (isSubscriptionPlanEvent(event))
    return event.subscriptionPlan.description ?? "";
  return "";
}

function getEventPrice(event: Event): number {
  if (isWebinarEvent(event)) return event.webinarPlan.price;
  if (isClassEvent(event)) return event.classPlan.price;
  if (isConsultationPlanEvent(event)) return event.consultationPlan.price;
  if (isSubscriptionPlanEvent(event)) return event.subscriptionPlan.price;
  return 0;
}

function getEventCurrency(event: Event): string {
  if (isWebinarEvent(event)) return event.webinarPlan.priceCurrency ?? "INR";
  if (isClassEvent(event)) return event.classPlan.priceCurrency ?? "INR";
  if (isConsultationPlanEvent(event))
    return event.consultationPlan.priceCurrency ?? "INR";
  if (isSubscriptionPlanEvent(event))
    return event.subscriptionPlan.priceCurrency ?? "INR";
  return "INR";
}

function getEventDuration(event: Event): string {
  if (isWebinarEvent(event)) {
    const hours = event.webinarPlan.durationInHours;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  if (isClassEvent(event)) {
    const months = event.classPlan.durationInMonths;
    return months === 1 ? "1 month" : `${months} months`;
  }
  if (isConsultationPlanEvent(event)) {
    const hours = event.consultationPlan.durationInHours;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  if (isSubscriptionPlanEvent(event)) {
    const months = event.subscriptionPlan.durationInMonths;
    return months === 1 ? "1 month" : `${months} months`;
  }
  return "";
}

function getMaxParticipants(event: Event): number {
  // The instance's own capacity wins; the plan supplies the default.
  if (isWebinarEvent(event))
    return effectiveMaxParticipants(event, event.webinarPlan);
  if (isClassEvent(event))
    return effectiveMaxParticipants(event, event.classPlan);
  return 1;
}

function getEventStatus(event: Event): WebinarStatus | ClassStatus | null {
  if (isWebinarEvent(event)) return event.status ?? null;
  if (isClassEvent(event)) return event.status ?? null;
  return null;
}

function getEventStartDate(event: Event): Date | null {
  if (isWebinarEvent(event)) {
    const startTimeString =
      event.appointment?.slotsOfAppointment?.[0]?.startsAt;
    return startTimeString ? new Date(startTimeString) : null;
  }
  if (isClassEvent(event)) {
    // #1346 — the card promises the first session, so read the scheduled slot
    // like the webinar arm above. A class fans out over many appointments and
    // the include carries no ordering, so take the earliest live slot rather
    // than trusting position 0. schedulingPeriodStartsAt is only the window the
    // run was authored with and drifts from the sessions actually allocated;
    // it stays as the fallback for a class that has none yet.
    const firstSlotStartsAt = (event.appointments ?? [])
      .flatMap((appointment) => appointment.slotsOfAppointment ?? [])
      .filter((slot) => !slot.deletedAt)
      .map((slot) => new Date(slot.startsAt).getTime())
      .reduce<number | null>(
        (earliest, startedAt) =>
          earliest === null || startedAt < earliest ? startedAt : earliest,
        null,
      );
    if (firstSlotStartsAt !== null) return new Date(firstSlotStartsAt);
    return event.schedulingPeriodStartsAt
      ? new Date(event.schedulingPeriodStartsAt)
      : null;
  }
  return null;
}

function formatDateTime(date: Date | null): string {
  if (!date) return "Unscheduled";
  try {
    return date.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return "Invalid Date";
  }
}

function getStatusVariant(
  status: WebinarStatus | ClassStatus,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case WebinarStatus.DRAFT:
    case ClassStatus.DRAFT:
      return "outline";
    case WebinarStatus.SCHEDULED:
    case ClassStatus.SCHEDULED:
      return "default";
    case WebinarStatus.IN_PROGRESS:
    case ClassStatus.IN_PROGRESS:
      return "secondary";
    case WebinarStatus.COMPLETED:
    case ClassStatus.COMPLETED:
      return "outline";
    case WebinarStatus.CANCELLED:
    case ClassStatus.CANCELLED:
      return "destructive";
  }
}

export function EventCard({
  event,
  eventType,
  participantCount,
  pendingTrialCount,
  collaboratorRole,
  isCollaborated,
  onEdit,
  onDelete,
  onTrialsClick,
  onJoinMeeting,
  canJoinNow,
  isJoiningMeeting,
  canManage = true,
  onArchiveToggle,
  isArchiveToggling,
}: Readonly<EventCardProps>) {
  const config = eventTypeConfig[eventType];
  const Icon = config.icon;

  const isArchived = getPlanArchivedAt(event) !== null;
  // Named here rather than nested in the JSX ternary below (sonar S3358).
  const ArchiveToggleIcon = isArchived ? Undo2 : Archive;
  const title = getEventTitle(event);
  const description = getEventDescription(event);
  const price = getEventPrice(event);
  const currency = getEventCurrency(event);
  const duration = getEventDuration(event);
  const maxParticipants = getMaxParticipants(event);
  const status = getEventStatus(event);
  const startDate = getEventStartDate(event);

  const isLiveSession = eventType === "webinar" || eventType === "class";
  const durationSuffix = isRecurringEventType(eventType) ? "/mo" : "";

  const hasTrialEnabled =
    isSubscriptionPlanEvent(event) && event.subscriptionPlan.trialEnabled;

  return (
    <motion.div
      whileHover={{ y: -2 }}
      transition={{ duration: 0.2 }}
      className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-sm transition-shadow hover:shadow-md"
    >
      {/* Accent strip */}
      <div className={cn("h-1 w-full shrink-0", config.accent)} />

      <div className="flex flex-1 flex-col p-4 sm:p-5">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
              config.iconBg,
            )}
          >
            <Icon className={cn("h-5 w-5", config.iconColor)} />
          </div>

          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                {config.label}
              </span>
              {isArchived && (
                <span
                  className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                  title="Off sale. Existing bookings continue."
                >
                  Archived
                </span>
              )}
              {collaboratorRole && (
                <span
                  className={cn(
                    "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                    isCollaborated
                      ? "bg-teal-50 text-teal-800"
                      : "bg-zinc-100 text-zinc-600",
                  )}
                >
                  {formatCollaboratorRole(collaboratorRole)}
                </span>
              )}
            </div>
            <h3
              className="text-[15px] font-semibold leading-snug tracking-tight text-zinc-900"
              title={title}
            >
              {title}
            </h3>
          </div>

          {!isCollaborated && (
            <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
              <Button
                variant="ghost"
                size="icon"
                disabled={!canManage}
                className="h-8 w-8 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                aria-label={`Edit ${title}`}
                title={canManage ? `Edit ${title}` : "Not saved yet"}
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
              >
                <Edit className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                disabled={!canManage}
                className="h-8 w-8 text-zinc-400 hover:bg-red-50 hover:text-red-600"
                aria-label={`Delete ${title}`}
                title={canManage ? `Delete ${title}` : "Not saved yet"}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
              {onArchiveToggle && (
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={!canManage || isArchiveToggling}
                  className="h-8 w-8 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900"
                  aria-label={`${isArchived ? "Restore" : "Archive"} ${title}`}
                  title={
                    isArchived
                      ? "Restore this offering to put it back on sale."
                      : "Archive this offering to stop new bookings. Existing appointments continue."
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    onArchiveToggle();
                  }}
                >
                  {isArchiveToggling ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ArchiveToggleIcon className="h-3.5 w-3.5" />
                  )}
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Description — 2 lines max, full title always visible above */}
        <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-zinc-500">
          {description || "No description provided"}
        </p>

        {isLiveSession && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-zinc-500">
              {formatDateTime(startDate)}
            </span>
            {status && (
              <Badge variant={getStatusVariant(status)} className="text-[10px]">
                {status.toString().replace("_", " ")}
              </Badge>
            )}
          </div>
        )}

        {isLiveSession && onJoinMeeting && (
          <div className="mt-3">
            <Button
              onClick={(e) => {
                e.stopPropagation();
                onJoinMeeting();
              }}
              disabled={
                process.env.NODE_ENV === "production"
                  ? !canJoinNow || isJoiningMeeting
                  : isJoiningMeeting
              }
              className={cn(
                "w-full gap-2 font-medium",
                canJoinNow
                  ? "bg-emerald-600 text-white hover:bg-emerald-700"
                  : "bg-zinc-100 text-zinc-500",
              )}
              size="sm"
            >
              {isJoiningMeeting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Joining...
                </>
              ) : (
                <>
                  <Video className="h-4 w-4" />
                  {process.env.NODE_ENV === "production"
                    ? canJoinNow
                      ? "Join Meeting"
                      : "Not Available Yet"
                    : "Join (Dev)"}
                </>
              )}
            </Button>
          </div>
        )}

        {(eventType === "webinar" || eventType === "class") && (
          <div className="mt-3 flex items-center gap-1.5 text-xs text-zinc-500">
            <Users className="h-3.5 w-3.5" />
            <span>
              {participantCount}/{maxParticipants} participants
            </span>
          </div>
        )}

        {hasTrialEnabled && onTrialsClick && (
          <div className="mt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onTrialsClick();
              }}
              className="w-full gap-2 border-teal-200 text-teal-800 hover:border-teal-300 hover:bg-teal-50"
            >
              <Gift className="h-4 w-4" />
              {pendingTrialCount && pendingTrialCount > 0
                ? `${pendingTrialCount} Trial Request${pendingTrialCount > 1 ? "s" : ""}`
                : "Trials"}
            </Button>
          </div>
        )}

        {/* Footer */}
        <div className="mt-auto flex items-end justify-between gap-3 border-t border-zinc-100 pt-4">
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">
              Price
            </p>
            <div className="mt-0.5 flex items-baseline gap-1">
              <span className="text-lg font-semibold tracking-tight text-zinc-900">
                {formatCurrency(price, currency)}
              </span>
              {durationSuffix && (
                <span className="text-xs text-zinc-400">{durationSuffix}</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5 rounded-lg bg-zinc-50 px-2.5 py-1.5 text-zinc-600 ring-1 ring-zinc-100">
            <Clock className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
            <span className="whitespace-nowrap text-xs font-medium">
              {duration}
            </span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
