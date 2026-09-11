"use client";

import * as Sentry from "@sentry/nextjs";
import React from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { ChevronLeftIcon, ChevronRightIcon } from "@radix-ui/react-icons";
import {
  MessageSquare,
  CalendarRange,
  Video,
  GraduationCap,
} from "lucide-react";
import { cn } from "@/utils/tailwind";
import {
  PlannerWebinarEvent,
  PlannerClassEvent,
  ConsultationPlanEvent,
  SubscriptionPlanEvent,
  Event,
} from "@/types/planner-events";
import {
  getPlanArchivedAt,
  getPlanId,
  isClassEvent,
  isConsultationPlanEvent,
  isSubscriptionPlanEvent,
  isWebinarEvent,
} from "@/lib/planner/archive-state";
import { EventCard } from "./EventCard";
import { FormConfirmationDialog } from "./form-fields/FormConfirmationDialog";

interface WebinarCarouselProps {
  events: PlannerWebinarEvent[];
  onEdit: (event: PlannerWebinarEvent) => void;
  onDelete: (eventId: string) => Promise<void>;
  eventType: "webinar";
  participantCounts: Record<string, number>;
  onJoinMeeting?: (event: PlannerWebinarEvent) => void;
  joinableEventIds?: Set<string>;
  joiningEventId?: string | null;
  onArchiveToggle?: (planId: string, archived: boolean) => void;
  archivingPlanId?: string | null;
}

interface ClassCarouselProps {
  events: PlannerClassEvent[];
  onEdit: (event: PlannerClassEvent) => void;
  onDelete: (eventId: string) => Promise<void>;
  eventType: "class";
  participantCounts: Record<string, number>;
  onJoinMeeting?: (event: PlannerClassEvent) => void;
  joinableEventIds?: Set<string>;
  joiningEventId?: string | null;
  onArchiveToggle?: (planId: string, archived: boolean) => void;
  archivingPlanId?: string | null;
}

interface ConsultationCarouselProps {
  events: ConsultationPlanEvent[];
  onEdit: (event: ConsultationPlanEvent) => void;
  onDelete: (eventId: string) => Promise<void>;
  eventType: "consultation";
  participantCounts: Record<string, number>;
  onArchiveToggle?: (planId: string, archived: boolean) => void;
  archivingPlanId?: string | null;
}

interface SubscriptionCarouselProps {
  events: SubscriptionPlanEvent[];
  onEdit: (event: SubscriptionPlanEvent) => void;
  onDelete: (eventId: string) => Promise<void>;
  eventType: "subscription";
  participantCounts: Record<string, number>;
  pendingTrialCounts?: Record<string, number>;
  onTrialsClick?: () => void;
  onArchiveToggle?: (planId: string, archived: boolean) => void;
  archivingPlanId?: string | null;
}

type EventCarouselProps =
  | WebinarCarouselProps
  | ClassCarouselProps
  | ConsultationCarouselProps
  | SubscriptionCarouselProps;

// Empty state configuration
const emptyStateConfig = {
  webinar: {
    icon: Video,
    title: "No webinars scheduled",
    description:
      "Create your first webinar to start hosting live sessions with multiple participants.",
    iconBg: "bg-emerald-50",
    iconColor: "text-emerald-600",
  },
  class: {
    icon: GraduationCap,
    title: "No classes created",
    description:
      "Design structured learning experiences with multi-session classes.",
    iconBg: "bg-amber-50",
    iconColor: "text-amber-600",
  },
  consultation: {
    icon: MessageSquare,
    title: "No consultation plans",
    description:
      "Create consultation plans to offer one-on-one sessions to your clients.",
    iconBg: "bg-blue-50",
    iconColor: "text-blue-600",
  },
  subscription: {
    icon: CalendarRange,
    title: "No subscription plans",
    description:
      "Set up subscription plans for ongoing mentorship relationships.",
    iconBg: "bg-teal-50",
    iconColor: "text-teal-600",
  },
};

// Animation variants
const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.08,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.3,
      ease: "easeOut",
    },
  },
};

export function EventCarousel({
  events,
  onEdit,
  onDelete,
  eventType,
  participantCounts,
  ...props
}: EventCarouselProps) {
  // Extract subscription-specific props
  const pendingTrialCounts =
    eventType === "subscription"
      ? (props as SubscriptionCarouselProps).pendingTrialCounts
      : undefined;
  const onTrialsClick =
    eventType === "subscription"
      ? (props as SubscriptionCarouselProps).onTrialsClick
      : undefined;

  // Extract join meeting props for webinar/class
  const onJoinMeeting =
    eventType === "webinar"
      ? (props as WebinarCarouselProps).onJoinMeeting
      : eventType === "class"
        ? (props as ClassCarouselProps).onJoinMeeting
        : undefined;
  const joinableEventIds =
    eventType === "webinar"
      ? (props as WebinarCarouselProps).joinableEventIds
      : eventType === "class"
        ? (props as ClassCarouselProps).joinableEventIds
        : undefined;
  const joiningEventId =
    eventType === "webinar"
      ? (props as WebinarCarouselProps).joiningEventId
      : eventType === "class"
        ? (props as ClassCarouselProps).joiningEventId
        : undefined;
  const onArchiveToggle = (props as { onArchiveToggle?: (planId: string, archived: boolean) => void })
    .onArchiveToggle;
  const archivingPlanId = (props as { archivingPlanId?: string | null })
    .archivingPlanId;
  const [currentPage, setCurrentPage] = React.useState(1);
  const itemsPerPage = 8;

  // Delete confirmation dialog state
  const [showDeleteDialog, setShowDeleteDialog] = React.useState(false);
  const [eventToDelete, setEventToDelete] = React.useState<Event | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);

  // Calculate pagination
  const totalPages = Math.ceil(events.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const currentEvents = events.slice(startIndex, endIndex);

  const goToNextPage = () => {
    setCurrentPage((prev) => Math.min(prev + 1, totalPages));
  };

  const goToPreviousPage = () => {
    setCurrentPage((prev) => Math.max(prev - 1, 1));
  };

  const getEventTitle = (event: Event): string => {
    if (isWebinarEvent(event)) return event.webinarPlan.title;
    if (isClassEvent(event)) return event.classPlan.title;
    if (isConsultationPlanEvent(event)) return event.consultationPlan.title;
    if (isSubscriptionPlanEvent(event)) return event.subscriptionPlan.title;
    return "";
  };

  const handleEdit = (event: Event) => {
    if (eventType === "webinar" && isWebinarEvent(event)) {
      (onEdit as (e: PlannerWebinarEvent) => void)(
        event as PlannerWebinarEvent,
      );
    } else if (eventType === "class" && isClassEvent(event)) {
      (onEdit as (e: PlannerClassEvent) => void)(event as PlannerClassEvent);
    } else if (eventType === "consultation" && isConsultationPlanEvent(event)) {
      onEdit(event);
    } else if (eventType === "subscription" && isSubscriptionPlanEvent(event)) {
      onEdit(event);
    }
  };

  // Open delete confirmation dialog
  const handleDeleteClick = (event: Event) => {
    setEventToDelete(event);
    setShowDeleteDialog(true);
  };

  // Execute the delete operation
  const handleDeleteConfirm = async () => {
    if (!eventToDelete) return;

    setIsDeleting(true);
    try {
      await onDelete(eventToDelete.id ?? "");
      setShowDeleteDialog(false);
      setEventToDelete(null);
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
      console.error(`Error deleting ${eventType}:`, error);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDeleteCancel = () => {
    setShowDeleteDialog(false);
    setEventToDelete(null);
  };

  // Empty state
  if (events.length === 0) {
    const config = emptyStateConfig[eventType];
    const Icon = config.icon;

    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="mx-0 flex flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-200 bg-gradient-to-b from-zinc-50/80 to-white px-6 py-12 text-center sm:py-14"
      >
        <div
          className={cn(
            "mb-4 flex h-12 w-12 items-center justify-center rounded-2xl ring-1 ring-black/5",
            config.iconBg,
          )}
        >
          <Icon className={cn("h-6 w-6", config.iconColor)} />
        </div>
        <h4 className="text-sm font-semibold tracking-tight text-zinc-900 sm:text-base">
          {config.title}
        </h4>
        <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-zinc-500 sm:text-sm">
          {config.description}
        </p>
      </motion.div>
    );
  }

  return (
    <div className="w-full">
      <motion.div
        className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-3"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
        key={currentPage} // Re-animate on page change
      >
        {currentEvents.map((event) => (
          <motion.div key={event.id} variants={itemVariants}>
            <EventCard
              event={event}
              eventType={eventType}
              participantCount={participantCounts[event.id ?? ""] ?? 0}
              pendingTrialCount={
                eventType === "subscription" && pendingTrialCounts
                  ? pendingTrialCounts[event.id ?? ""]
                  : undefined
              }
              collaboratorRole={
                "collaboratorRole" in event
                  ? (event as { collaboratorRole: string }).collaboratorRole
                  : undefined
              }
              isCollaborated={
                "isCollaborated" in event
                  ? (event as { isCollaborated: boolean }).isCollaborated
                  : undefined
              }
              onEdit={() => handleEdit(event)}
              onDelete={() => handleDeleteClick(event)}
              canManage={Boolean(event.id)}
              onTrialsClick={
                eventType === "subscription" &&
                onTrialsClick &&
                isSubscriptionPlanEvent(event)
                  ? onTrialsClick
                  : undefined
              }
              onJoinMeeting={
                onJoinMeeting &&
                (eventType === "webinar" || eventType === "class")
                  ? () =>
                      onJoinMeeting(
                        event as PlannerWebinarEvent & PlannerClassEvent,
                      )
                  : undefined
              }
              canJoinNow={joinableEventIds?.has(event.id ?? "") ?? false}
              isJoiningMeeting={joiningEventId === event.id}
              onArchiveToggle={
                onArchiveToggle && getPlanId(event)
                  ? () =>
                      onArchiveToggle(
                        getPlanId(event) as string,
                        getPlanArchivedAt(event) === null,
                      )
                  : undefined
              }
              isArchiveToggling={
                archivingPlanId !== null &&
                archivingPlanId !== undefined &&
                archivingPlanId === getPlanId(event)
              }
            />
          </motion.div>
        ))}
      </motion.div>

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex justify-center items-center gap-3 sm:gap-4 mt-6 sm:mt-8">
          <Button
            variant="outline"
            size="icon"
            onClick={goToPreviousPage}
            disabled={currentPage === 1}
            className="h-8 w-8 sm:h-9 sm:w-9"
          >
            <ChevronLeftIcon className="h-4 w-4" />
          </Button>
          <span className="text-xs sm:text-sm text-zinc-600">
            Page {currentPage} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={goToNextPage}
            disabled={currentPage === totalPages}
            className="h-8 w-8 sm:h-9 sm:w-9"
          >
            <ChevronRightIcon className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <FormConfirmationDialog
        isOpen={showDeleteDialog}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
        title={`Delete ${eventType === "consultation" || eventType === "subscription" ? `${eventType} plan` : eventType}?`}
        description={`Are you sure you want to delete "${eventToDelete ? getEventTitle(eventToDelete) : ""}"? This action cannot be undone.`}
        isLoading={isDeleting}
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
      />
    </div>
  );
}
