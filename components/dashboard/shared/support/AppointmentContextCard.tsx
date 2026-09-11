"use client";

import React from "react";
import { Calendar, User, Clock, Link2 } from "lucide-react";
import { cn } from "@/utils/tailwind";

export interface AppointmentContextData {
  appointmentId: string;
  appointmentType: "CONSULTATION" | "SUBSCRIPTION";
  appointmentStatus: "COMPLETED" | "UPCOMING";
  consultantName?: string;
  scheduledAt?: string;
}

interface AppointmentContextCardProps {
  context: AppointmentContextData;
  onClear?: () => void;
  className?: string;
}

/**
 * Displays linked appointment context when creating a support ticket
 * from an appointment card
 */
export function AppointmentContextCard({
  context,
  onClear,
  className,
}: AppointmentContextCardProps) {
  const { appointmentType, appointmentStatus, consultantName, scheduledAt } =
    context;

  const formatDate = (dateString?: string) => {
    if (!dateString) return null;
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return dateString;
    }
  };

  const typeLabel =
    appointmentType === "CONSULTATION" ? "Consultation" : "Subscription";
  const statusLabel =
    appointmentStatus === "COMPLETED" ? "Completed" : "Upcoming";
  // COMPLETED keeps its semantic green; the off-brand blue UPCOMING accent
  // collapses to neutral monochrome.
  const statusColor =
    appointmentStatus === "COMPLETED"
      ? "bg-green-50 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800"
      : "bg-muted text-muted-foreground border-border";

  return (
    <div
      className={cn(
        "p-4 rounded-xl bg-muted border border-border",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-md bg-background">
            <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <span className="text-xs font-medium text-foreground">
            Linked to {typeLabel}
          </span>
        </div>
        {onClear && (
          <button
            onClick={onClear}
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Clear link
          </button>
        )}
      </div>

      {/* Context Details */}
      <div className="space-y-2">
        {consultantName && (
          <div className="flex items-center gap-2 text-sm">
            <User className="h-4 w-4 text-muted-foreground/70" />
            <span className="font-medium text-foreground">
              {consultantName}
            </span>
          </div>
        )}

        {scheduledAt && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Calendar className="h-4 w-4 text-muted-foreground/70" />
            <span>{formatDate(scheduledAt)}</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground/70" />
          <span
            className={cn(
              "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border",
              statusColor,
            )}
          >
            {statusLabel}
          </span>
        </div>
      </div>

      {/* Helper Text */}
      <p className="mt-3 text-xs text-muted-foreground">
        Your support ticket will be linked to this {typeLabel.toLowerCase()} for
        faster resolution.
      </p>
    </div>
  );
}
