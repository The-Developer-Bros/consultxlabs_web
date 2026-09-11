import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";

/**
 * #997 Phase 3 — one confirmed (non-tentative) appointment whose slot count
 * matches slotsPerCall = one completed call. Bucketed by the SAME
 * scheduling-timezone week key (ADR B9) the server validator uses, so the
 * interactive weekly-limit guard can do an O(1) lookup instead of
 * re-deriving this from a separate whole-window appointment fetch on every
 * slot click (previously UnifiedCalendar's countCompletedCallsForWeek).
 */
export function computeWeeklyConfirmedCallCounts(
  appointments: Array<{
    appointmentType: string;
    subscription?: { id?: string; schedulingTimezone?: string | null } | null;
    slotsOfAppointment?: Array<{ startsAt: Date | string; isTentative?: boolean }>;
  }>,
  subscriptionId: string,
  slotsPerCall: number,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const appt of appointments) {
    if (appt.appointmentType !== "SUBSCRIPTION") continue;
    if (appt.subscription?.id !== subscriptionId) continue;
    const slots = appt.slotsOfAppointment || [];
    // Tentative slots are the OLD slots mid-reschedule — never a completed call.
    if (slots.some((s) => s.isTentative)) continue;
    if (slots.length !== slotsPerCall) continue;
    const firstSlot = slots[0];
    if (!firstSlot?.startsAt) continue;
    const weekKey = SlotCalculationService.weekKey(
      new Date(firstSlot.startsAt),
      appt.subscription?.schedulingTimezone || undefined,
    );
    counts[weekKey] = (counts[weekKey] || 0) + 1;
  }
  return counts;
}
