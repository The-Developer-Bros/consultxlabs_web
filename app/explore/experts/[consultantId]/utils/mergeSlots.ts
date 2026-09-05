import type { ProcessedSlot } from "../types";

/**
 * Merge consecutive slots with the same booking status for display purposes.
 * E.g., "3:30-4:00" + "4:00-4:30" + "4:30-5:00" (all available) → "3:30-5:00 PM"
 *
 * The only difference from `mergeConsecutiveSlots()` in
 * utils/timeSlotsProcessing.ts is which slots are eligible: that one merges
 * available slots only, because it feeds booking; this one merges any run that
 * shares a status, because it feeds the expert page's availability card. The
 * adjacency rule is identical in both.
 */
export function mergeConsecutiveSlotsForDisplay(
  slots: ProcessedSlot[],
): ProcessedSlot[] {
  if (!slots || slots.length === 0) return [];

  const sorted = [...slots].sort((a, b) => {
    const aStart = a.startsAt ? new Date(a.startsAt).getTime() : 0;
    const bStart = b.startsAt ? new Date(b.startsAt).getTime() : 0;
    return aStart - bStart;
  });

  const merged: ProcessedSlot[] = [];
  let current = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];

    const currentEnd = current.endsAt ? new Date(current.endsAt).getTime() : 0;
    const nextStart = next.startsAt ? new Date(next.startsAt).getTime() : 0;

    // #1416 — exact adjacency, the same rule booking uses. A 60-second
    // tolerance advertised a window whose seam no availability row publishes,
    // and checkout's per-atom union coverage then rejected the booking this
    // card had just promised.
    const isConsecutive = currentEnd === nextStart;
    const sameStatus = getEffectiveStatus(current) === getEffectiveStatus(next);

    if (isConsecutive && sameStatus) {
      // Extend the current merged slot
      current = {
        ...current,
        endsAt: next.endsAt,
        localEndTime: next.localEndTime,
      };
    } else {
      merged.push(current);
      current = { ...next };
    }
  }

  merged.push(current);
  return merged;
}

/** Derive a single status key that accounts for isAllocated + bookingStatus */
function getEffectiveStatus(slot: ProcessedSlot): string {
  if (slot.bookingStatus === "fully-booked") return "fully-booked";
  if (slot.bookingStatus === "partially-booked") return "partially-booked";
  if (slot.isAllocated) return "allocated";
  return "available";
}
