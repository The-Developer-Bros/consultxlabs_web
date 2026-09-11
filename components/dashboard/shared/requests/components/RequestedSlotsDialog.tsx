import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AppointmentsType } from "@prisma/client";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AllocationService } from "@/lib/scheduling/allocationService";
import { TimeSlot } from "@/lib/scheduling/calendarUtils";
import type { SlotConflictResult } from "@/utils/slotAllocation/types";

// Slot with tentative status
interface SlotWithStatus {
  startsAt: string;
  isTentative: boolean;
}

interface ValidationResult extends SlotConflictResult {
  outsidePeriod?: Array<{
    slot: string;
  }>;
}

interface RequestedSlotsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
  requestType: AppointmentsType;
  requestedSlots: string[];
  requestedSlotsWithStatus?: SlotWithStatus[]; // New: includes tentative info
  schedulingPeriod?: { startDate?: Date; endDate?: Date };
  /** Parent's confirm is in flight — hold both exits so a double click can't
   * fire a second submit. #1163 */
  confirming?: boolean;
  /**
   * A reschedule with no answerable consultee proposal cannot confirm its
   * stored times: those rows still carry the times being moved AWAY from
   * (the reschedule route never rewrites startsAt), so the server's
   * requested-slots mode refuses them by design. When set, the confirm
   * button is replaced with guidance toward the Allocate Slots surface,
   * which is where replacement times are actually placed.
   */
  rescheduleNeedsAllocator?: boolean;
  onConfirm: (override: boolean) => Promise<void>;
  onCancel: () => void;
}

export function RequestedSlotsDialog({
  open,
  onOpenChange,
  requestId,
  requestType,
  requestedSlots,
  requestedSlotsWithStatus,
  schedulingPeriod,
  confirming = false,
  rescheduleNeedsAllocator = false,
  onConfirm,
  onCancel,
}: RequestedSlotsDialogProps) {
  // Calculate reschedule info from slots with status
  const tentativeCount =
    requestedSlotsWithStatus?.filter((s) => s.isTentative).length ?? 0;
  const totalCount = requestedSlotsWithStatus?.length ?? requestedSlots.length;
  const hasReschedule = tentativeCount > 0;
  const isFullReschedule = tentativeCount === totalCount && tentativeCount > 0;
  const [loading, setLoading] = useState(false);
  const [validationResult, setValidationResult] =
    useState<ValidationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Validate slots when dialog opens
  const validateSlots = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const eventType =
        requestType === AppointmentsType.SUBSCRIPTION
          ? "subscription"
          : "consultation";

      // Convert requested slots to TimeSlot objects
      const timeSlots: TimeSlot[] = requestedSlots.map((slotString) => {
        const startTime = new Date(slotString);
        const endTime = new Date(startTime.getTime() + 30 * 60 * 1000); // 30 minutes later
        return {
          startTime,
          endTime,
          isAvailable: true,
          isBooked: false,
        };
      });

      // Server-side validation (conflicts, availability)
      const validationResponse = await AllocationService.validateSlots(
        eventType,
        requestId,
        timeSlots,
      );

      if (!validationResponse.success) {
        throw new Error(validationResponse.error || "Failed to validate slots");
      }

      // Client-side scheduling period validation
      const outsidePeriodSlots: Array<{ slot: string }> = [];
      if (schedulingPeriod?.startDate && schedulingPeriod?.endDate) {
        requestedSlots.forEach((slot) => {
          const slotDate = new Date(slot);
          const slotEndDate = new Date(slotDate.getTime() + 30 * 60 * 1000);
          if (
            slotDate < schedulingPeriod.startDate! ||
            slotEndDate > schedulingPeriod.endDate!
          ) {
            outsidePeriodSlots.push({ slot });
          }
        });
      }

      // Merge server-side and client-side validation results
      setValidationResult({
        conflicts: validationResponse.data?.conflicts || [],
        outsideAvailability: validationResponse.data?.outsideAvailability || [],
        outsidePeriod: outsidePeriodSlots,
        validSlots: validationResponse.data?.validSlots || [],
      });
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "client" } });
      setError(err instanceof Error ? err.message : "Failed to validate slots");
    } finally {
      setLoading(false);
    }
  }, [requestType, requestedSlots, requestId, schedulingPeriod]);

  // Validate on open
  useEffect(() => {
    if (open) {
      validateSlots();
    }
  }, [open, requestId, requestedSlots, validateSlots]);

  // Safe access to validation result arrays
  const conflicts = validationResult?.conflicts || [];
  const outsideAvailability = validationResult?.outsideAvailability || [];
  const outsidePeriod = validationResult?.outsidePeriod || [];
  const _validSlots = validationResult?.validSlots || [];
  const hasConflicts = conflicts.length > 0;
  const hasOutsideSlots = outsideAvailability.length > 0;
  const hasOutsidePeriod = outsidePeriod.length > 0;
  const hasIssues = hasConflicts || hasOutsideSlots || hasOutsidePeriod;

  // Calculate available slots count
  const availableSlotsCount =
    requestedSlots.length -
    conflicts.length -
    outsideAvailability.length -
    outsidePeriod.length;

  // Group slots by date for better visualization
  const groupSlotsByDate = (slots: string[]) => {
    const grouped = new Map<string, string[]>();
    slots.forEach((slot) => {
      const date = new Date(slot).toLocaleDateString();
      if (!grouped.has(date)) {
        grouped.set(date, []);
      }
      grouped.get(date)?.push(slot);
    });
    return grouped;
  };

  const renderDialogContent = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center p-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
        </div>
      );
    }

    if (error) {
      return (
        <div className="bg-red-50 p-4 rounded-md">
          <p className="text-red-700 mb-3">{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={validateSlots}
            className="text-red-700 border-red-300"
          >
            Retry Validation
          </Button>
        </div>
      );
    }

    if (validationResult) {
      return (
        <>
          {/* Summary Statistics Section */}
          <div className="bg-gray-50 p-4 rounded-md mb-4 border border-gray-200">
            <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <span>📊</span> Validation Summary
            </h3>
            <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div className="flex items-center justify-between">
                <span className="text-gray-600">Total Slots:</span>
                <span className="font-semibold text-gray-900">
                  {requestedSlots.length}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-600 flex items-center gap-1">
                  <span className="text-green-600">✅</span> Available:
                </span>
                <span className="font-semibold text-green-700">
                  {availableSlotsCount}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-600 flex items-center gap-1">
                  <span className="text-red-600">🔴</span> Conflicting:
                </span>
                <span className="font-semibold text-red-700">
                  {conflicts.length}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-600 flex items-center gap-1">
                  <span className="text-yellow-600">🟡</span> Outside
                  Availability:
                </span>
                <span className="font-semibold text-yellow-700">
                  {outsideAvailability.length}
                </span>
              </div>
              {requestType === AppointmentsType.SUBSCRIPTION && (
                <div className="col-span-1 flex items-center justify-between sm:col-span-2">
                  <span className="text-gray-600 flex items-center gap-1">
                    <span className="text-blue-600">🔵</span> Outside Period:
                  </span>
                  <span className="font-semibold text-blue-700">
                    {outsidePeriod.length}
                  </span>
                </div>
              )}
            </div>
          </div>

          {hasConflicts && (
            <div className="bg-red-50 p-4 rounded-md mb-4 border border-red-200">
              <h3 className="font-semibold text-red-900 mb-2 flex items-center gap-2">
                <span>🔴</span> Conflicting Slots ({conflicts.length})
              </h3>
              <div className="max-h-48 overflow-y-auto mb-2">
                <ul className="space-y-1">
                  {conflicts.map((conflict) => (
                    <li key={conflict.slot} className="text-sm text-red-700">
                      <span className="font-medium">
                        {new Date(conflict.slot).toLocaleString()}
                      </span>
                      {" - "}
                      {conflict.existingAppointment.type} with{" "}
                      {conflict.existingAppointment.with}
                    </li>
                  ))}
                </ul>
              </div>
              <p className="text-xs text-red-600">
                ❌ Cannot allocate slots that conflict with existing
                appointments.
              </p>
            </div>
          )}

          {hasOutsideSlots && (
            <div className="bg-yellow-50 p-4 rounded-md mb-4 border border-yellow-200">
              <h3 className="font-semibold text-yellow-900 mb-2 flex items-center gap-2">
                <span>🟡</span> Slots Outside Availability (
                {outsideAvailability.length})
              </h3>
              <div className="max-h-48 overflow-y-auto mb-2">
                {/* Group outside availability slots by date */}
                {Array.from(
                  groupSlotsByDate(outsideAvailability.map((s) => s.slot)),
                ).map(([date, slots]) => (
                  <div key={date} className="mb-2">
                    <p className="text-sm font-medium text-yellow-900">
                      {date}:
                    </p>
                    <ul className="ml-3 space-y-1">
                      {slots.map((slot) => (
                        <li key={slot} className="text-sm text-yellow-700">
                          {new Date(slot).toLocaleTimeString()}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <p className="text-sm text-yellow-700 font-medium">
                ⚠️ These slots are outside your regular availability. You can
                override and allocate them if needed.
              </p>
            </div>
          )}

          {hasOutsidePeriod && (
            <div className="bg-blue-50 p-4 rounded-md mb-4 border border-blue-200">
              <h3 className="font-semibold text-blue-900 mb-2 flex items-center gap-2">
                <span>🔵</span> Slots Outside Scheduling Period (
                {outsidePeriod.length})
              </h3>
              <p className="text-sm text-blue-700 mb-3">
                The following slots are outside the subscription scheduling
                period{" "}
                {schedulingPeriod?.startDate && schedulingPeriod?.endDate && (
                  <>
                    ({schedulingPeriod.startDate.toLocaleDateString()} -{" "}
                    {schedulingPeriod.endDate.toLocaleDateString()})
                  </>
                )}
                :
              </p>
              <div className="max-h-48 overflow-y-auto mb-2">
                {/* Group outside period slots by date */}
                {Array.from(
                  groupSlotsByDate(outsidePeriod.map((s) => s.slot)),
                ).map(([date, slots]) => (
                  <div key={date} className="mb-2">
                    <p className="text-sm font-medium text-blue-800">{date}:</p>
                    <ul className="ml-3 space-y-1">
                      {slots.map((slot) => (
                        <li key={slot} className="text-sm text-blue-700">
                          {new Date(slot).toLocaleTimeString()}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <p className="text-xs text-blue-600">
                ❌ Cannot allocate slots outside the subscription period.
              </p>
            </div>
          )}

          {/* Show available slots section */}
          {!hasIssues ? (
            /* All slots available - show immediately */
            <div className="bg-green-50 p-4 rounded-md mb-4 border border-green-200">
              <h3 className="font-semibold text-green-900 mb-2 flex items-center gap-2">
                <span>✅</span> All Slots Available
              </h3>
              <p className="text-sm text-green-700 mb-3">
                All {requestedSlots.length} requested slots are within your
                availability and have no conflicts.
              </p>
              {/* Show requested slots - collapsible if more than 10 */}
              {requestedSlots.length <= 10 ? (
                <div className="text-sm text-green-700">
                  <p className="font-medium mb-1">Requested Times:</p>
                  <div className="ml-2 space-y-1">
                    {requestedSlots.map((slot, index) => (
                      <div key={slot + index}>
                        {new Date(slot).toLocaleString()}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <details className="mt-2">
                  <summary className="cursor-pointer font-medium text-green-800 hover:text-green-900 select-none">
                    ▶ View all {requestedSlots.length} available slots
                  </summary>
                  <div className="mt-3 max-h-64 overflow-y-auto text-sm text-green-700">
                    {Array.from(groupSlotsByDate(requestedSlots)).map(
                      ([date, slots]) => (
                        <div key={date} className="mb-2">
                          <p className="font-medium text-green-900">{date}:</p>
                          <div className="ml-3 space-y-1">
                            {slots.map((s, idx) => (
                              <div key={s + idx}>
                                {new Date(s).toLocaleTimeString()}
                              </div>
                            ))}
                          </div>
                        </div>
                      ),
                    )}
                  </div>
                </details>
              )}
            </div>
          ) : availableSlotsCount > 0 ? (
            /* Some issues but also some available - show collapsible */
            <details className="bg-green-50 p-4 rounded-md border border-green-200">
              <summary className="cursor-pointer font-semibold text-green-900 hover:text-green-800 select-none flex items-center gap-2">
                <span>▶</span> View {availableSlotsCount} available slot
                {availableSlotsCount !== 1 ? "s" : ""}
              </summary>
              <div className="mt-3 max-h-64 overflow-y-auto text-sm text-green-700">
                {Array.from(
                  groupSlotsByDate(
                    requestedSlots.filter(
                      (slot) =>
                        !conflicts.some((c) => c.slot === slot) &&
                        !outsideAvailability.some((o) => o.slot === slot) &&
                        !outsidePeriod.some((p) => p.slot === slot),
                    ),
                  ),
                ).map(([date, slots]) => (
                  <div key={date} className="mb-2">
                    <p className="font-medium text-green-900">{date}:</p>
                    <div className="ml-3 space-y-1">
                      {slots.map((s, idx) => (
                        <div key={s + idx}>
                          {new Date(s).toLocaleTimeString()}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </>
      );
    }

    return null; // Should not happen if validation runs on open
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-hidden flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Confirm Slot Allocation</DialogTitle>
          <DialogDescription>
            Review requested slots before allocation
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Reschedule indicator */}
          {hasReschedule && (
            <div className="mb-4">
              {isFullReschedule ? (
                <div className="flex items-center gap-2 text-sm font-medium text-blue-600 bg-blue-50 px-3 py-2 rounded-md border border-blue-200">
                  <RefreshCw className="h-4 w-4" />
                  <span>
                    Full Reschedule - All {totalCount} session
                    {totalCount !== 1 ? "s" : ""} need new times
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm font-medium text-amber-600 bg-amber-50 px-3 py-2 rounded-md border border-amber-200">
                  <AlertTriangle className="h-4 w-4" />
                  <span>
                    Partial Reschedule - {tentativeCount} of {totalCount}{" "}
                    session{tentativeCount !== 1 ? "s" : ""} need new times
                  </span>
                </div>
              )}
            </div>
          )}

          {renderDialogContent()}
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t pt-4">
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={loading || confirming}
          >
            Cancel
          </Button>

          {rescheduleNeedsAllocator ? (
            // The stored times are what the consultee asked to MOVE AWAY
            // from — confirming them here would re-book the very times the
            // reschedule is trying to leave, and the server refuses it.
            // Point at the surface that places replacement times instead of
            // letting a guaranteed-failing submit answer as an error toast.
            <Button
              variant="outline"
              disabled
              title="A reschedule needs new times. Open Allocate Slots to place replacements."
            >
              Use Allocate Slots for new times
            </Button>
          ) : (
            <Button
              variant={hasOutsideSlots ? "destructive" : "default"}
              onClick={() => onConfirm(hasOutsideSlots)}
              disabled={
                loading || confirming || hasConflicts || hasOutsidePeriod
              }
              title={
                hasConflicts
                  ? `Cannot allocate: ${conflicts.length} slot(s) have conflicts with existing appointments`
                  : hasOutsidePeriod
                    ? `Cannot allocate: ${outsidePeriod.length} slot(s) are outside the subscription scheduling period`
                    : hasOutsideSlots
                      ? `Warning: ${outsideAvailability.length} slot(s) are outside your regular availability. Click to override and allocate.`
                      : "Allocate all requested time slots"
              }
            >
              {hasOutsideSlots
                ? "Override and Allocate"
                : "Allocate Requested Times"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
