"use client";

import React from "react";
import { format } from "date-fns";
import { CalendarClock, CalendarRange, Check, CheckSquare } from "lucide-react";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toDate, type SlotLike } from "@/lib/appointments/view-model";
import { cn } from "@/utils/tailwind";

/**
 * Which sessions of a booking are being released, for the reschedule
 * surfaces. Lifted out of the reschedule modal it replaced, unchanged in behaviour;
 * `SlotPicker` shows it beside the grid rather than as a first step, because a
 * page has the width the dialog did not.
 */

export type ReleaseMode = "individual" | "multiple" | "entire";

export interface ReleasableSession {
  slots: SlotLike[];
  startTime: Date;
  endTime: Date;
}

/**
 * Sessions of a booking, newest last. One session can span several 30-minute
 * slots (ADR B1), so they group by owning appointment; a slot with no
 * appointment id stands alone.
 */
export function groupReleasableSessions(
  slots: readonly SlotLike[],
): ReleasableSession[] {
  const groups = new Map<string, SlotLike[]>();
  for (const slot of slots) {
    if (slot.isTentative) continue;
    const key = slot.appointmentId ?? slot.id;
    const bucket = groups.get(key);
    if (bucket) bucket.push(slot);
    else groups.set(key, [slot]);
  }
  return Array.from(groups.values())
    .map((sessionSlots) => {
      const sorted = [...sessionSlots].sort(
        (a, b) => toDate(a.startsAt).getTime() - toDate(b.startsAt).getTime(),
      );
      const last = sorted[sorted.length - 1];
      return {
        slots: sorted,
        startTime: toDate(sorted[0].startsAt),
        endTime: toDate(last.endsAt ?? last.startsAt),
      };
    })
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

function isWithinLeadTime(session: ReleasableSession, minLeadHours: number) {
  if (minLeadHours <= 0) return false;
  return (
    (session.startTime.getTime() - Date.now()) / (1000 * 60 * 60) <
    minLeadHours
  );
}

function SessionList({
  mode,
  sessions,
  minLeadHours,
  selectedSlotIds,
  onChange,
}: Readonly<{
  mode: Exclude<ReleaseMode, "entire">;
  sessions: ReleasableSession[];
  minLeadHours: number;
  selectedSlotIds: string[];
  onChange: React.Dispatch<React.SetStateAction<string[]>>;
}>) {
  return (
    <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-border p-2">
      {sessions.map((session) => {
        const sessionSlotIds = session.slots.map((s) => s.id);
        const isSelected = sessionSlotIds.every((id) =>
          selectedSlotIds.includes(id),
        );
        const locked = isWithinLeadTime(session, minLeadHours);

        const toggle = () => {
          if (locked) return;
          if (mode === "individual") {
            onChange(sessionSlotIds);
          } else if (isSelected) {
            onChange((prev) =>
              prev.filter((id) => !sessionSlotIds.includes(id)),
            );
          } else {
            onChange((prev) =>
              Array.from(new Set([...prev, ...sessionSlotIds])),
            );
          }
        };

        return (
          <button
            // The sorted list reorders when subject.slots changes; the first
            // slot's id is stable across that, an index is not.
            key={sessionSlotIds[0]}
            type="button"
            onClick={toggle}
            disabled={locked}
            className={cn(
              "flex w-full items-center justify-between rounded-md p-2.5 text-left transition-colors",
              isSelected
                ? "bg-primary text-primary-foreground"
                : locked
                  ? "cursor-not-allowed bg-muted text-muted-foreground/70"
                  : "bg-muted text-foreground hover:bg-muted/80",
            )}
          >
            <div className="flex items-center gap-2">
              {mode === "multiple" && (
                <div
                  className={cn(
                    "flex h-4 w-4 items-center justify-center rounded border",
                    isSelected
                      ? "border-primary-foreground bg-primary-foreground"
                      : locked
                        ? "border-border"
                        : "border-muted-foreground",
                  )}
                >
                  {isSelected && <Check className="h-3 w-3 text-primary" />}
                </div>
              )}
              <div>
                <div className="text-sm font-medium">
                  {format(session.startTime, "EEE, d MMM yyyy")}
                </div>
                <div
                  className={cn(
                    "text-xs",
                    isSelected
                      ? "text-primary-foreground/70"
                      : "text-muted-foreground",
                  )}
                >
                  {format(session.startTime, "h:mm a")} &ndash;{" "}
                  {format(session.endTime, "h:mm a")}
                </div>
              </div>
            </div>
            {locked && (
              <span className="rounded bg-orange-100 px-2 py-0.5 text-xs text-orange-600 dark:bg-orange-900/30 dark:text-orange-300">
                Within {minLeadHours}h
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

const MODE_OPTIONS: {
  value: ReleaseMode;
  icon: typeof CalendarClock;
  label: string;
  hint: (sessionCount: number) => string;
}[] = [
  {
    value: "individual",
    icon: CalendarClock,
    label: "One session",
    hint: () => "Only the session you pick moves.",
  },
  {
    value: "multiple",
    icon: CheckSquare,
    label: "Several sessions",
    hint: () => "Pick exactly which sessions move.",
  },
  {
    value: "entire",
    icon: CalendarRange,
    label: "Every session",
    hint: (count) => `All ${count} sessions are released.`,
  },
];

export function SessionReleasePicker({
  sessions,
  minLeadHours,
  mode,
  onModeChange,
  selectedSlotIds,
  onSelectionChange,
}: Readonly<{
  sessions: ReleasableSession[];
  minLeadHours: number;
  mode: ReleaseMode;
  onModeChange: (mode: ReleaseMode) => void;
  selectedSlotIds: string[];
  onSelectionChange: React.Dispatch<React.SetStateAction<string[]>>;
}>) {
  const handleModeChange = (next: ReleaseMode) => {
    onModeChange(next);
    if (next === "entire") {
      onSelectionChange([]);
      return;
    }
    if (next === "individual") {
      // Narrowing from "several" must leave exactly one session ticked, or the
      // submit sits disabled with every box still visibly checked.
      const alreadyPicked = sessions.find((session) =>
        session.slots.some((slot) => selectedSlotIds.includes(slot.id)),
      );
      // NOT sessions[0]: the list is earliest-first, so the first entry is the
      // one most likely to be inside the lead window — and SessionList
      // disables that row, leaving it ticked and untickable. The submit stays
      // enabled (it only counts selected ids), so the server rejects a release
      // the user cannot change.
      const target =
        alreadyPicked ??
        sessions.find((session) => !isWithinLeadTime(session, minLeadHours));
      onSelectionChange(target ? target.slots.map((s) => s.id) : []);
    }
  };

  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium text-foreground">
        What is moving?
      </Label>

      <RadioGroup
        value={mode}
        onValueChange={(value) => handleModeChange(value as ReleaseMode)}
        className="grid gap-2 sm:grid-cols-3"
      >
        {MODE_OPTIONS.map((option) => (
          <div
            key={option.value}
            className={cn(
              "flex items-start gap-2 rounded-lg border p-3 transition-colors",
              mode === option.value
                ? "border-primary bg-muted"
                : "border-border hover:border-foreground/30",
            )}
          >
            <RadioGroupItem
              value={option.value}
              id={`release-${option.value}`}
              className="mt-1"
            />
            <Label
              htmlFor={`release-${option.value}`}
              className="flex-1 cursor-pointer"
            >
              <span className="flex items-center gap-2 font-medium text-foreground">
                <option.icon className="h-4 w-4" />
                {option.label}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {option.hint(sessions.length)}
              </span>
            </Label>
          </div>
        ))}
      </RadioGroup>

      {mode !== "entire" && (
        <SessionList
          mode={mode}
          sessions={sessions}
          minLeadHours={minLeadHours}
          selectedSlotIds={selectedSlotIds}
          onChange={onSelectionChange}
        />
      )}
    </div>
  );
}
