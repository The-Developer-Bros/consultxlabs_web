"use client";

import React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DesktopOnlyNotice } from "@/components/scheduling/DesktopOnlyNotice";
import { SafeUnifiedCalendar } from "@/components/scheduling/SafeUnifiedCalendar";
import {
  groupReleasableSessions,
  SessionReleasePicker,
  type ReleaseMode,
} from "@/components/scheduling/SessionReleasePicker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  acceptsSlotPreference,
  type SlotPickerPolicy,
  type SlotPickerSubject,
  type SlotPreference,
} from "@/components/scheduling/slot-picker-policy";
import { resolveFocusTarget } from "@/lib/scheduling/slot-picker-focus";
import { cn } from "@/utils/tailwind";

/**
 * The one surface for choosing times, shared by allocation, both reschedule
 * roles and a consultant's own event timings.
 *
 * It takes a policy object rather than a prop per difference. The four callers
 * disagree about lead time, whether anything is being released and who owns
 * the submit; all of that is data in `slot-picker-policy.ts`, so nothing here
 * branches on which caller it is.
 */

/**
 * "No preference" needs a real value because Radix treats the empty string as
 * "clear the selection" and refuses it as an item value.
 */
const NO_PREFERENCE = "ANY";

const TIME_OF_DAY_OPTIONS = [
  { value: NO_PREFERENCE, label: "Any time of day" },
  { value: "MORNING", label: "Mornings" },
  { value: "AFTERNOON", label: "Afternoons" },
  { value: "EVENING", label: "Evenings" },
] as const;

const DAYS_OPTIONS = [
  { value: NO_PREFERENCE, label: "Any day" },
  { value: "WEEKDAYS", label: "Weekdays" },
  { value: "WEEKENDS", label: "Weekends" },
] as const;

export interface SlotPickerProps {
  policy: SlotPickerPolicy;
  subject: SlotPickerSubject;
  /** A submit is in flight; the policy's owner knows, this component does not. */
  isSubmitting?: boolean;
  /** Back out. Also wired to the allocate grid's own Cancel button. */
  onCancel?: () => void;
  className?: string;
}

export function SlotPicker({
  policy,
  subject,
  isSubmitting = false,
  onCancel,
  className,
}: Readonly<SlotPickerProps>) {
  const sessions = React.useMemo(
    () => groupReleasableSessions(subject.slots ?? []),
    [subject.slots],
  );

  // "First open" is this mount, and the target is pinned to it. Re-resolving
  // against a moving `now` would let the grid drift under a consultant who
  // left the tab open (#1073).
  const [openedAt] = React.useState(() => new Date());
  const focus = React.useMemo(
    () => resolveFocusTarget(subject, openedAt),
    [subject, openedAt],
  );

  const [releaseMode, setReleaseMode] = React.useState<ReleaseMode>("entire");
  const [selectedSlotIds, setSelectedSlotIds] = React.useState<string[]>([]);
  const [proposedSlots, setProposedSlots] = React.useState<
    { startsAt: string; endsAt: string }[]
  >([]);
  const [timeOfDay, setTimeOfDay] = React.useState<string>(NO_PREFERENCE);
  const [days, setDays] = React.useState<string>(NO_PREFERENCE);

  /** A one-session booking has nothing to choose between. */
  const showReleaseStep = policy.showReleasedSlots && sessions.length > 1;
  const picksSpecificSessions = showReleaseStep && releaseMode !== "entire";

  /** A picking mode is active but nothing is ticked — there is no request yet. */
  const selectionIncomplete =
    picksSpecificSessions && selectedSlotIds.length === 0;

  const releasedSlotIds = picksSpecificSessions
    ? selectedSlotIds
    : /* Every session; the API reads an absent list as "all of them". */
      undefined;

  const selectedSessionCount = React.useMemo(
    () =>
      sessions.filter((session) =>
        session.slots.every((slot) => selectedSlotIds.includes(slot.id)),
      ).length,
    [sessions, selectedSlotIds],
  );

  /** How many times to ask for, so the hint matches what is actually moving. */
  const sessionsBeingMoved = picksSpecificSessions
    ? Math.max(selectedSessionCount, 1)
    : Math.max(sessions.length, 1);

  /**
   * The stated preference, or undefined when nothing was chosen. Only travels
   * on the no-times submit: picking a concrete time already says everything a
   * preference could.
   */
  /**
   * Group events never reach the server's proposal path, so a preference stated
   * on one would be dropped without a word. Gate the control on the same rule.
   */
  const canStatePreference =
    policy.allowReleaseWithoutTime && acceptsSlotPreference(subject.eventType);

  const preference = (): SlotPreference | undefined => {
    if (!canStatePreference) return undefined;

    const stated: SlotPreference = {
      ...(timeOfDay !== NO_PREFERENCE && {
        preferredTimeOfDay: timeOfDay as SlotPreference["preferredTimeOfDay"],
      }),
      ...(days !== NO_PREFERENCE && {
        preferredDays: days as SlotPreference["preferredDays"],
      }),
    };
    return Object.keys(stated).length > 0 ? stated : undefined;
  };

  const submit = (withTimes: boolean) => {
    const named = withTimes && proposedSlots.length > 0;
    void policy.onSubmit({
      slotIds: releasedSlotIds,
      proposedSlots: named ? proposedSlots : undefined,
      preference: named ? undefined : preference(),
    });
  };

  const isSelectMode = policy.calendarMode === "select";

  return (
    <DesktopOnlyNotice className={cn("min-h-0 gap-4", className)}>
      {policy.minLeadHours > 0 && (
        <div className="shrink-0 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-900/20">
          <p className="text-xs text-amber-800 dark:text-amber-300">
            <strong>Note:</strong> sessions cannot be moved within{" "}
            {policy.minLeadHours} hours of their start time, and rescheduling
            is not refunded.
          </p>
        </div>
      )}

      {showReleaseStep && (
        <div className="shrink-0">
          <SessionReleasePicker
            sessions={sessions}
            minLeadHours={policy.minLeadHours}
            mode={releaseMode}
            onModeChange={setReleaseMode}
            selectedSlotIds={selectedSlotIds}
            onSelectionChange={setSelectedSlotIds}
          />
        </div>
      )}

      <p className="shrink-0 text-sm text-muted-foreground">
        {isSelectMode && (
          <span className="font-medium text-foreground">
            {sessionsBeingMoved === 1
              ? "Pick a time. "
              : `Pick ${sessionsBeingMoved} times. `}
          </span>
        )}
        {policy.pickerHint}
      </p>

      <SafeUnifiedCalendar
        className="min-h-0 flex-1"
        consultantId={subject.consultantProfileId}
        eventType={subject.eventType}
        eventId={subject.eventId}
        consulteeUserId={subject.counterpartUserId}
        mode={policy.calendarMode}
        // Consultant surfaces (allocate / manage timings / propose) paint
        // Selected / Being moved / This booking. Consultee reschedule stays
        // on the buyer legend even when eventId is set for status-grid paint.
        showConsultantLegend={
          policy.kind === "RESCHEDULE_CONSULTANT" ||
          policy.kind === "MANAGE_TIMINGS" ||
          policy.kind === "ALLOCATE"
        }
        sessionDurationInHours={subject.sessionDurationInHours}
        durationInHours={subject.durationInHours}
        sessionsPerWeek={subject.sessionsPerWeek}
        durationInMonths={subject.durationInMonths}
        totalSessions={subject.totalSessions}
        schedulingTimezone={subject.schedulingTimezone}
        allowedStart={subject.allowedStart}
        allowedEnd={subject.allowedEnd}
        // Deliberately NOT keyed to the release selection: focus is a
        // starting position, and re-aiming the grid while someone is reading
        // it is worse than the empty night rows it replaces (#1073).
        focus={focus}
        // Fresh allocations only: a partial reschedule legitimately keeps
        // confirmed slots and must not trip the guard.
        initialAllocation={
          policy.appliesInitialAllocationGuard
            ? !subject.hasReleasedSlots
            : undefined
        }
        // #1012 — when this is a reschedule (released/tentative slots), pin
        // the tentative count so a stale tab 409s instead of replacing.
        expectedTentativeSlotCount={
          subject.hasReleasedSlots
            ? (subject.slots?.filter((s) => s.isTentative).length ?? 0)
            : undefined
        }
        showAllocationButtons={!isSelectMode}
        onSlotsSelected={(slots) =>
          setProposedSlots(
            slots.map((slot) => ({
              startsAt: slot.startTime.toISOString(),
              endsAt: slot.endTime.toISOString(),
            })),
          )
        }
        onAllocationComplete={() => void policy.onSubmit({})}
        onAllocationConflict={policy.onConflict}
        onClose={onCancel}
      />

      {/* Only "select" needs a footer — the allocate grid renders its own. */}
      {isSelectMode && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {/* Sits with "Any time works" because it only applies to that button:
              it is how you say "any time, but ideally these" instead of naming
              one. The allocator ranks candidates by it and never rules any out,
              so an impossible pairing still gets the booking placed (#1065). */}
          {canStatePreference && proposedSlots.length === 0 && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">Ideally</span>
              <Select value={timeOfDay} onValueChange={setTimeOfDay}>
                <SelectTrigger className="h-9 w-[9.5rem]" aria-label="Preferred time of day">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIME_OF_DAY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={days} onValueChange={setDays}>
                <SelectTrigger className="h-9 w-[8rem]" aria-label="Preferred days">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAYS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {proposedSlots.length > 0 && (
            <p className="mr-auto text-sm text-muted-foreground">
              {proposedSlots.length} slot
              {proposedSlots.length === 1 ? "" : "s"} selected.
            </p>
          )}

          {onCancel && (
            <Button variant="outline" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </Button>
          )}

          {/* Naming a time is an OPTION, never a requirement. Releasing without
              one hands the counterparty a request to place, which is how every
              reschedule worked before proposals existed — so this stays on
              every reschedule surface and at every session count. */}
          {policy.allowReleaseWithoutTime && (
            <Button
              variant="outline"
              onClick={() => submit(false)}
              disabled={isSubmitting || selectionIncomplete}
            >
              Any time works
            </Button>
          )}

          <Button
            onClick={() => submit(true)}
            disabled={
              isSubmitting || selectionIncomplete || proposedSlots.length === 0
            }
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Processing...
              </>
            ) : (
              policy.submitLabel
            )}
          </Button>
        </div>
      )}
    </DesktopOnlyNotice>
  );
}
