"use client";

import Link from "next/link";
import { format } from "date-fns";
import { ArrowUpRight, CreditCard } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { eventUnionStatusBadge } from "@/lib/appointments/status";
import type { AppointmentActionAdapter } from "@/lib/appointments/adapter";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import { trialCheckoutHref } from "@/lib/appointments/trial-checkout-href";
import { CountdownBadge } from "./CountdownBadge";
import { KIND_LABEL } from "./AppointmentRow";
import { RowPrimaryAction } from "./RowPrimaryAction";
import { SessionTimeline } from "./SessionTimeline";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

interface AppointmentSheetProps {
  vm: AppointmentVM | null;
  onOpenChange: (open: boolean) => void;
  adapter: AppointmentActionAdapter;
  sponsoredLabel?: string | null;
  joinWindowMs?: number;
}

/**
 * Slide-over summary for a row click: schedule + countdown, full session
 * timeline, payment/sponsorship notes, quick actions, and the link to the
 * full detail page when one exists.
 */
export function AppointmentSheet({
  vm,
  onOpenChange,
  adapter,
  sponsoredLabel,
  joinWindowMs,
}: AppointmentSheetProps) {
  if (!vm) return null;

  const action = adapter.primaryAction(vm);
  const overflow = adapter.overflowItems(vm);
  const detailHref = adapter.detailHref(vm);
  const anchorSession = vm.nextAt
    ? vm.sessions.find((s) => s.startsAt.getTime() === vm.nextAt?.getTime())
    : undefined;
  const anchorOver = vm.nextAt
    ? (anchorSession?.endsAt?.getTime() ??
        vm.nextAt.getTime() + 60 * 60 * 1000) < Date.now()
    : false;
  const hasConcreteSessions = vm.sessions.some((s) => !s.isTentative);
  const allTentative = vm.sessions.length > 0 && !hasConcreteSessions;

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-md max-h-[100dvh]">
        <SheetHeader className="shrink-0 space-y-3 border-b border-border px-5 py-5 text-left sm:px-6 sm:py-6">
          <div className="flex items-start gap-3">
            <Avatar className="h-11 w-11 border border-border shrink-0">
              <AvatarImage
                src={vm.counterpart.image ?? undefined}
                alt={vm.counterpart.name}
              />
              <AvatarFallback className="text-sm font-medium">
                {initials(vm.counterpart.name) || "?"}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <SheetTitle className="text-base leading-snug">
                {vm.title}
              </SheetTitle>
              <SheetDescription className="mt-0.5">
                {KIND_LABEL[vm.kind]}
                {vm.meta ? ` · ${vm.meta}` : ""} · with {vm.counterpart.name}
              </SheetDescription>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              {...eventUnionStatusBadge(vm.status)}
              withDot
              size="sm"
            />
            {sponsoredLabel && (
              <span className="rounded bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 px-1.5 py-px text-[10px] font-medium">
                Sponsored · {sponsoredLabel}
              </span>
            )}
            {vm.collaboratorRole && (
              <span className="rounded bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300 px-1.5 py-px text-[10px] font-medium">
                Your role: {vm.collaboratorRole}
              </span>
            )}
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6 sm:py-6">
          <div className="space-y-5">
            {/* Next session */}
            {vm.nextAt && (
              <div className="rounded-lg bg-muted border border-border p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  {vm.bucket === "past" || anchorOver
                    ? "Last session"
                    : "Next session"}
                </p>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-foreground tabular-nums">
                    {format(vm.nextAt, "EEE, d MMM yyyy · h:mm a")}
                    {anchorSession?.endsAt && (
                      <span className="text-muted-foreground font-normal">
                        {" – "}
                        {format(anchorSession.endsAt, "h:mm a")}
                      </span>
                    )}
                  </p>
                  {vm.bucket !== "past" && vm.bucket !== "cancelled" && (
                    <CountdownBadge
                      targetDate={vm.nextAt}
                      sessionEndDate={anchorSession?.endsAt ?? undefined}
                    />
                  )}
                </div>
              </div>
            )}

            {/* Group progress */}
            {vm.group && vm.group.total > 0 && (
              <div>
                <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
                  <span>Progress</span>
                  <span className="font-medium text-foreground">
                    {vm.group.completed} of {vm.group.total} sessions
                  </span>
                </div>
                <Progress
                  value={
                    // A group whose sessions have no slots yet has total 0,
                    // and 0/0 is NaN — which reaches Progress as an
                    // attribute value and renders a broken bar.
                    vm.group.total > 0
                      ? (vm.group.completed / vm.group.total) * 100
                      : 0
                  }
                  className="h-2"
                />
              </div>
            )}

            {/* Timeline (tentative-only / slot-less rows get a note instead) */}
            {(allTentative || vm.sessions.length === 0) && (
              <p className="text-xs text-muted-foreground rounded-lg bg-muted border border-border p-3">
                {allTentative
                  ? "Awaiting schedule confirmation."
                  : vm.needsActionReason === "UNSCHEDULED"
                    ? "No sessions scheduled yet — set a schedule to get started."
                    : "No sessions scheduled yet."}
              </p>
            )}
            {hasConcreteSessions && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  Sessions
                </p>
                <SessionTimeline
                  sessions={vm.sessions}
                  joinWindowMs={joinWindowMs}
                  isJoining={action.kind === "join" && !!action.busy}
                  onJoinSession={
                    action.kind === "join" && action.onClick
                      ? () => action.onClick!()
                      : undefined
                  }
                />
              </div>
            )}

            {/* Payment note */}
            {vm.needsActionReason === "PAY_NOW" && vm.pendingPaymentUrl && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/20 p-3">
                <p className="text-xs text-amber-800 dark:text-amber-300 mb-2">
                  Complete payment to confirm this booking.
                </p>
                <Button
                  size="sm"
                  className="w-full bg-amber-500 hover:bg-amber-600 text-white dark:bg-amber-600 dark:hover:bg-amber-500"
                  onClick={() => {
                    // #1167/#1429 — a trial goes to our own branded checkout
                    // page, not the raw gateway link. The branch lives in the
                    // shared helper so every Pay Now surface answers alike.
                    const trialHref = trialCheckoutHref(vm);
                    if (trialHref) {
                      window.location.href = trialHref;
                      return;
                    }
                    if (/^https?:\/\//.test(vm.pendingPaymentUrl!)) {
                      window.open(
                        vm.pendingPaymentUrl!,
                        "_blank",
                        "noopener,noreferrer",
                      );
                    }
                  }}
                >
                  <CreditCard className="h-4 w-4 mr-2" />
                  Pay Now to Confirm
                </Button>
              </div>
            )}

            {/* Actions — the sheet IS the "view", so a bare View primary is
              redundant here; only stateful actions render. */}
            {(action.kind !== "view" || overflow.length > 0 || detailHref) && (
              <div className="space-y-2 border-t border-border pt-4">
                {action.kind !== "view" && (
                  <div className="[&>*]:w-full">
                    <RowPrimaryAction action={action} size="default" />
                  </div>
                )}
                {overflow.length > 0 && (
                  <div className="grid grid-cols-2 gap-2">
                    {overflow.map((item) => (
                      <Button
                        key={item.key}
                        variant="outline"
                        size="sm"
                        disabled={item.disabled}
                        onClick={item.onClick}
                        className={
                          item.destructive
                            ? "text-red-600 border-red-200 hover:bg-red-50 dark:text-red-400 dark:border-red-900/40 dark:hover:bg-red-900/20"
                            : undefined
                        }
                      >
                        {item.label}
                      </Button>
                    ))}
                  </div>
                )}
                {detailHref && (
                  <Button variant="ghost" size="sm" className="w-full" asChild>
                    <Link href={detailHref}>
                      View full details
                      <ArrowUpRight className="h-3.5 w-3.5 ml-1" />
                    </Link>
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
