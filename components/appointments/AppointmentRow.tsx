"use client";

import { format } from "date-fns";
import { motion } from "framer-motion";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { eventUnionStatusBadge } from "@/lib/appointments/status";
import { getProximityLabel } from "@/lib/appointments/slots";
import type { AppointmentActionAdapter } from "@/lib/appointments/adapter";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import { cn } from "@/utils/tailwind";
import { RowPrimaryAction } from "./RowPrimaryAction";
import { RowOverflowMenu } from "./RowOverflowMenu";

export const KIND_LABEL: Record<AppointmentVM["kind"], string> = {
  CONSULTATION: "Consultation",
  SUBSCRIPTION: "Subscription",
  WEBINAR: "Webinar",
  CLASS: "Class",
  TRIAL: "Trial",
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

interface AppointmentRowProps {
  vm: AppointmentVM;
  adapter: AppointmentActionAdapter;
  /** "Sponsored · <Org>" label resolved by the shell from session memberships. */
  sponsoredLabel?: string | null;
  onOpen?: (vm: AppointmentVM) => void;
  highlighted?: boolean;
  registerRef?: (el: HTMLDivElement | null) => void;
}

export function AppointmentRow({
  vm,
  adapter,
  sponsoredLabel,
  onOpen,
  highlighted = false,
  registerRef,
}: AppointmentRowProps) {
  const action = adapter.primaryAction(vm);
  const overflow = adapter.overflowItems(vm);
  const badge = eventUnionStatusBadge(vm.status);
  const proximity =
    vm.bucket === "upcoming" || vm.bucket === "needsAction"
      ? getProximityLabel(vm.nextAt)
      : null;

  const timeLabel = vm.nextAt ? format(vm.nextAt, "h:mm a") : "Not scheduled";
  const endOfAnchor = vm.nextAt
    ? vm.sessions.find(
        (s) => s.startsAt.getTime() === vm.nextAt?.getTime() && s.endsAt,
      )?.endsAt
    : null;

  const open = onOpen ? () => onOpen(vm) : undefined;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      ref={registerRef}
      onClick={open}
      role={open ? "button" : undefined}
      tabIndex={open ? 0 : undefined}
      onKeyDown={
        open
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                open();
              }
            }
          : undefined
      }
      className={cn(
        "group flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-border bg-card p-3 sm:p-4 transition-all",
        open && "cursor-pointer hover:border-foreground/20 hover:shadow-md",
        highlighted &&
          "ring-2 ring-primary ring-offset-2 ring-offset-background",
        (vm.bucket === "past" || vm.bucket === "cancelled") && "opacity-80",
      )}
    >
      {/* Identity */}
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <Avatar className="h-10 w-10 shrink-0 border border-border">
          <AvatarImage
            src={vm.counterpart.image ?? undefined}
            alt={vm.counterpart.name}
          />
          <AvatarFallback className="text-xs font-medium">
            {initials(vm.counterpart.name) || "?"}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <p className="font-medium text-sm text-foreground truncate">
              {vm.title}
            </p>
            <span className="hidden sm:inline-flex shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {KIND_LABEL[vm.kind]}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground mt-0.5">
            <span className="truncate">{vm.counterpart.name}</span>
            {vm.collaboratorRole && (
              <span className="shrink-0 rounded bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300 px-1.5 py-px text-[10px] font-medium">
                {vm.collaboratorRole}
              </span>
            )}
            {vm.meta && <span className="truncate">{vm.meta}</span>}
            {vm.group && (
              <span className="shrink-0 font-medium text-foreground/80">
                {vm.group.completed}/{vm.group.total} sessions
              </span>
            )}
            {sponsoredLabel && (
              <span className="shrink-0 rounded bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 px-1.5 py-px text-[10px] font-medium">
                Sponsored · {sponsoredLabel}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Schedule + status + actions */}
      <div className="flex items-center justify-between sm:justify-end gap-3 sm:gap-4 pl-[52px] sm:pl-0">
        <div className="text-right shrink-0">
          <p className="text-sm font-medium text-foreground tabular-nums">
            {timeLabel}
            {endOfAnchor && (
              <span className="text-muted-foreground font-normal">
                {" – "}
                {format(endOfAnchor, "h:mm a")}
              </span>
            )}
          </p>
          {proximity && (
            <p className="text-[11px] text-muted-foreground">{proximity}</p>
          )}
        </div>
        <StatusBadge {...badge} withDot size="sm" />
        <div className="flex items-center gap-1.5">
          <RowPrimaryAction action={action} onView={open} />
          <RowOverflowMenu items={overflow} />
        </div>
      </div>
    </motion.div>
  );
}
