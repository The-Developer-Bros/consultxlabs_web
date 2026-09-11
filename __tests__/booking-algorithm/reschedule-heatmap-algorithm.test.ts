/**
 * Regression pins for the reschedule/timings heatmap selection rules:
 * contiguous N×30 groups, same-day (ADR B9), and status precedence so
 * "Being moved" does not paint as a foreign "Booked".
 */

import "./setup";

import {
  findConsecutiveGroupContaining,
  isCompleteCall,
} from "@/lib/scheduling/slotSelectionValidation";
import { resolveSlotStatusKey } from "@/lib/scheduling/slot-status-tokens";
import type { TimeSlot } from "@/hooks/scheduling/useCalendarData";

const slot = (hour: number, minute = 0): TimeSlot => {
  const start = new Date(Date.UTC(2026, 7, 7, hour, minute, 0));
  return {
    startTime: start,
    endTime: new Date(start.getTime() + 30 * 60 * 1000),
    isAvailable: true,
    isBooked: false,
  };
};

describe("contiguous session groups (heatmap selection)", () => {
  it("treats four half-hour atoms as one complete 2h call", () => {
    const day = [slot(15, 30), slot(16, 0), slot(16, 30), slot(17, 0)];
    expect(isCompleteCall(day, 4)).toBe(true);
  });

  it("rejects a gap inside the run", () => {
    const day = [slot(15, 30), slot(16, 0), slot(17, 0), slot(17, 30)];
    expect(isCompleteCall(day, 4)).toBe(false);
  });

  it("deselection expands to the full consecutive group containing the click", () => {
    const day = [slot(15, 30), slot(16, 0), slot(16, 30), slot(17, 0)];
    const group = findConsecutiveGroupContaining(day[2], day);
    expect(group).toHaveLength(4);
    expect(group[0].startTime.toISOString()).toBe(day[0].startTime.toISOString());
    expect(group[3].startTime.toISOString()).toBe(day[3].startTime.toISOString());
  });
});

describe("status precedence for Being moved vs Booked vs Selected", () => {
  const base = {
    isSelected: false,
    isThisEventSlot: false,
    isRescheduling: false,
    isBookedForDisplay: false,
    isPartiallyBooked: false,
    isAvailable: true,
    isInPast: false,
  };

  it("Selected wins over Being moved and This booking", () => {
    expect(
      resolveSlotStatusKey({
        ...base,
        isSelected: true,
        isRescheduling: true,
        isThisEventSlot: true,
      }),
    ).toBe("selected");
  });

  it("Being moved wins over foreign Booked paint", () => {
    // Tentative slots of THIS event must not fall through to fullyBooked.
    expect(
      resolveSlotStatusKey({
        ...base,
        isRescheduling: true,
        isBookedForDisplay: true,
      }),
    ).toBe("rescheduling");
  });

  it("This booking wins over Booked", () => {
    expect(
      resolveSlotStatusKey({
        ...base,
        isThisEventSlot: true,
        isBookedForDisplay: true,
      }),
    ).toBe("thisEvent");
  });
});
