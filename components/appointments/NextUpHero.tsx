"use client";

import { format } from "date-fns";
import { motion } from "framer-motion";
import { CalendarCheck } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { eventUnionStatusBadge } from "@/lib/appointments/status";
import { getProximityLabel } from "@/lib/appointments/slots";
import type { AppointmentActionAdapter } from "@/lib/appointments/adapter";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import { CountdownBadge } from "./CountdownBadge";
import { RowPrimaryAction } from "./RowPrimaryAction";
import { KIND_LABEL } from "./AppointmentRow";

export interface HeroStat {
  label: string;
  value: number | string;
}

interface NextUpHeroProps {
  /** The next upcoming appointment, or null → slim "no upcoming" strip. */
  vm: AppointmentVM | null;
  adapter: AppointmentActionAdapter;
  stats: HeroStat[];
  onOpen?: (vm: AppointmentVM) => void;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function NextUpHero({ vm, adapter, stats, onOpen }: NextUpHeroProps) {
  if (!vm) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 shadow-sm">
        <CalendarCheck className="h-4 w-4 text-muted-foreground shrink-0" />
        <p className="text-sm text-muted-foreground flex-1">
          No upcoming sessions scheduled.
        </p>
        <StatChips stats={stats} />
      </div>
    );
  }

  const anchorSession = vm.nextAt
    ? vm.sessions.find((s) => s.startsAt.getTime() === vm.nextAt?.getTime())
    : undefined;
  const proximity = getProximityLabel(vm.nextAt);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden"
    >
      <div className="flex flex-col lg:flex-row">
        <div className="flex-1 p-4 sm:p-5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Next appointment
          </p>
          <div className="flex items-start gap-4">
            <Avatar className="h-12 w-12 border border-border shrink-0">
              <AvatarImage
                src={vm.counterpart.image ?? undefined}
                alt={vm.counterpart.name}
              />
              <AvatarFallback className="text-sm font-medium">
                {initials(vm.counterpart.name) || "?"}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={onOpen ? () => onOpen(vm) : undefined}
                  className="font-semibold text-foreground text-base truncate hover:underline underline-offset-2 text-left"
                >
                  {vm.title}
                </button>
                <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground shrink-0">
                  {KIND_LABEL[vm.kind]}
                </span>
                <StatusBadge {...eventUnionStatusBadge(vm.status)} withDot size="sm" />
              </div>
              <p className="text-sm text-muted-foreground mt-0.5 truncate">
                with {vm.counterpart.name}
              </p>
              {vm.nextAt && (
                <div className="flex flex-wrap items-center gap-2 mt-2 text-sm">
                  <span className="font-medium text-foreground tabular-nums">
                    {format(vm.nextAt, "EEE, d MMM · h:mm a")}
                    {anchorSession?.endsAt && (
                      <span className="text-muted-foreground font-normal">
                        {" – "}
                        {format(anchorSession.endsAt, "h:mm a")}
                      </span>
                    )}
                  </span>
                  <CountdownBadge
                    targetDate={vm.nextAt}
                    sessionEndDate={anchorSession?.endsAt ?? undefined}
                  />
                  {proximity && (
                    <span className="text-xs text-muted-foreground">
                      {proximity}
                    </span>
                  )}
                </div>
              )}
              <div className="mt-3">
                <RowPrimaryAction
                  action={adapter.primaryAction(vm)}
                  onView={onOpen ? () => onOpen(vm) : undefined}
                  size="default"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex lg:flex-col gap-px bg-border lg:w-48 border-t lg:border-t-0 lg:border-l border-border">
          <StatChips stats={stats} vertical />
        </div>
      </div>
    </motion.div>
  );
}

function StatChips({
  stats,
  vertical = false,
}: {
  stats: HeroStat[];
  vertical?: boolean;
}) {
  if (stats.length === 0) return null;
  return (
    <>
      {stats.map((stat) =>
        vertical ? (
          <div
            key={stat.label}
            className="flex-1 bg-card px-4 py-3 lg:py-0 lg:flex lg:flex-col lg:justify-center"
          >
            <p className="text-lg font-semibold text-foreground tabular-nums">
              {stat.value}
            </p>
            <p className="text-[11px] text-muted-foreground">{stat.label}</p>
          </div>
        ) : (
          <div key={stat.label} className="text-right shrink-0 px-2">
            <span className="text-sm font-semibold text-foreground tabular-nums mr-1">
              {stat.value}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {stat.label}
            </span>
          </div>
        ),
      )}
    </>
  );
}
