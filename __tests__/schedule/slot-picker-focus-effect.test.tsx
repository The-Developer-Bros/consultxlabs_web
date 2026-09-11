// #1073 — the focus effect itself, which is where all the risk in this change
// lives: it has to fire exactly once, and it has to fire at all.
//
// The week grid does not exist until `consultantDetails` has arrived, and
// `useCalendarData` fetches details and availability independently. Keying the
// effect on anything that settles BEFORE the grid mounts means it runs against
// a null container, returns, and — a ref being unable to wake an effect —
// never runs again. That failure is silent and race-dependent, which is why it
// is pinned here rather than left to manual testing.

jest.mock("@prisma/client", () => ({
  DayOfWeek: {
    SUNDAY: "SUNDAY",
    MONDAY: "MONDAY",
    TUESDAY: "TUESDAY",
    WEDNESDAY: "WEDNESDAY",
    THURSDAY: "THURSDAY",
    FRIDAY: "FRIDAY",
    SATURDAY: "SATURDAY",
  },
  Prisma: {},
}));

jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock("../../hooks/scheduling/useCalendarData", () => ({
  useCalendarData: () => calendarData,
}));

jest.mock("../../hooks/scheduling/useSlotAllocation", () => ({
  useEventSlotAllocation: () => allocation,
}));

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { UnifiedCalendar } from "../../components/scheduling/UnifiedCalendar";
import {
  FOCUS_LEAD_ROWS,
  type SlotPickerFocus,
} from "../../lib/scheduling/slot-picker-focus";

/** Every row is one of these tall; jsdom has no layout, so we supply it. */
const ROW_HEIGHT = 32;
/** 10:30 on the target day → hour 10, half-hour 1. */
const TARGET_ROW = 21;
/** FOCUS_LEAD_ROWS of headroom, so the target is in view and not clipped. */
const EXPECTED_SCROLL_ROW = TARGET_ROW - FOCUS_LEAD_ROWS;

const SCROLL_CONTAINER_CLASS = "overflow-y-auto";

function slotStatus(interval: { hour: number; minute: number }, date: Date) {
  const start = new Date(date);
  start.setHours(interval.hour, interval.minute, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return {
    isAvailable: true,
    isBooked: false,
    isBookedForDisplay: false,
    isPartiallyBooked: false,
    isDisabled: false,
    isInPast: false,
    intervalStartUTCString: start.toISOString(),
    intervalEndUTCString: end.toISOString(),
    localStartTime: start,
    localEndTime: end,
    overlappingAppointments: [],
  };
}

let calendarData: Record<string, unknown>;
let allocation: Record<string, unknown>;

// ONE array, reused across renders. A fresh `[]` each time would change the
// identity of a value the pre-fix effect listed in its deps, which is enough
// to wake it by accident and hide the very bug these tests exist to catch.
const NO_AVAILABILITY: { startTime: Date }[] = [];

function setCalendarData(overrides: Record<string, unknown> = {}) {
  calendarData = {
    consultantDetails: { id: "consultant-1" },
    availableSlots: NO_AVAILABILITY,
    eventSlots: [],
    eventTentativeSlots: [],
    weeklyConfirmedCallCounts: {},
    loading: false,
    error: null,
    refetch: jest.fn(),
    refetchEventSlots: jest.fn(),
    refetchAvailability: jest.fn(),
    getSlotStatusForInterval: slotStatus,
    ...overrides,
  };
}

function resetAllocation() {
  allocation = {
    selectedSlots: [],
    setSelectedSlots: jest.fn(),
    isAllocating: false,
    allocationError: null,
    isValid: true,
    validationErrors: [],
    requiredSlots: 2,
    toggleSlot: jest.fn(),
    clearSlots: jest.fn(),
    isSlotSelected: () => false,
    manualAllocate: jest.fn(),
    autoAllocate: jest.fn(),
    allocateRequestedSlots: jest.fn(),
    slotLimits: { slotsPerSession: 2, maxSlots: 10, totalSessions: 5 },
  };
}

/**
 * jsdom reports every rect as zero, so the measured scroll would always be a
 * no-op. Give the scroll container's own children a height, keyed off their
 * position, and leave everything else at the origin.
 */
function stubLayout() {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const parent = this.parentElement;
    const isGridRow = parent?.classList.contains(SCROLL_CONTAINER_CLASS);
    const top = isGridRow
      ? Array.prototype.indexOf.call(parent!.children, this) * ROW_HEIGHT
      : 0;
    return { top, bottom: top + ROW_HEIGHT, height: ROW_HEIGHT } as DOMRect;
  };
}

function weekGrid(host: HTMLElement): HTMLElement {
  const grid = host.querySelector(`.${SCROLL_CONTAINER_CLASS}`);
  if (!(grid instanceof HTMLElement)) throw new Error("week grid not rendered");
  return grid;
}

// Local noon so the row is read in the same zone the grid draws in, whatever
// zone the test happens to run in.
const target = new Date(2026, 7, 1, 10, 30, 0, 0);
const focus: SlotPickerFocus = { at: target, precision: "session" };

describe("UnifiedCalendar focus effect", () => {
  let host: HTMLElement;
  let root: Root;
  const originalRect = Element.prototype.getBoundingClientRect;

  beforeAll(() => {
    (global as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
      true;
    stubLayout();
  });

  afterAll(() => {
    Element.prototype.getBoundingClientRect = originalRect;
  });

  beforeEach(() => {
    setCalendarData();
    resetAllocation();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(props: Record<string, unknown> = {}) {
    act(() => {
      root.render(
        <UnifiedCalendar
          consultantId="consultant-1"
          eventType="consultation"
          eventId="event-1"
          mode="allocate"
          durationInHours={1}
          focus={focus}
          {...props}
        />,
      );
    });
  }

  it("scrolls the target into view with rows to spare above it", () => {
    render();

    expect(weekGrid(host).scrollTop).toBe(EXPECTED_SCROLL_ROW * ROW_HEIGHT);
  });

  it("fires once the grid appears, even when it appears late", () => {
    // The race: availability settles first, so the effect's other inputs are
    // already final while the grid is still unrendered.
    setCalendarData({ consultantDetails: null });
    render();
    expect(host.querySelector(`.${SCROLL_CONTAINER_CLASS}`)).toBeNull();

    // Details arrive. NOTHING else changes — not availability, not `loading`,
    // not the view. Only the grid's existence is new.
    setCalendarData();
    render();

    expect(weekGrid(host).scrollTop).toBe(EXPECTED_SCROLL_ROW * ROW_HEIGHT);
  });

  it("never re-aims the grid once the consultant has scrolled away", () => {
    render();
    const grid = weekGrid(host);
    grid.scrollTop = 900;

    // A refetch: new availability, new array identity, same focus.
    setCalendarData({ availableSlots: [{ startTime: target }] });
    render();

    expect(weekGrid(host).scrollTop).toBe(900);
  });

  it("does nothing at all without a focus target", () => {
    render({ focus: undefined });

    expect(weekGrid(host).scrollTop).toBe(0);
  });

  it("anchors a period target on first published availability, not midnight", () => {
    // Midnight on the target day carries no time of day; 09:00 is where the
    // consultant's grid actually has something in it.
    const start = new Date(2026, 7, 1, 0, 0, 0, 0);
    setCalendarData({
      availableSlots: [{ startTime: new Date(2026, 7, 3, 9, 0, 0, 0) }],
    });
    render({ focus: { at: start, precision: "period" } });

    // Row 18 is 09:00; two rows of headroom leaves 16.
    expect(weekGrid(host).scrollTop).toBe(16 * ROW_HEIGHT);
  });
});
