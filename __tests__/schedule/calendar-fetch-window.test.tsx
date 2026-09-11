// The availability window the calendar asks the server for.
//
// The grid always draws a full week. When allocate mode clamped the request to
// the scheduling period's end, every cell past that end had no server row, and
// because the route filters APPOINTMENTS by the same window, the booked cells
// in that range disappeared too — which is what ruled out a per-week cap or a
// disabled state as the cause. One week further on, `endDate` fell before
// `startDate`, the server had nothing to return, and the entire grid blanked
// until the consultant pressed `‹`.
//
// These assertions are on the ARGUMENTS of the fetch, deliberately: the bug was
// never in how a slot renders, so nothing about the rendered grid could have
// caught it.

jest.mock("../../lib/scheduling/allocationService", () => ({
  AllocationService: {
    fetchAvailabilitySlots: jest.fn(),
    fetchConsultantData: jest.fn(),
    fetchEventSlots: jest.fn(),
  },
}));

// ONE toast function for the life of the module. A fresh `jest.fn()` per call
// would change `toast`'s identity on every render, and `toast` is a dependency
// of the fetch callback that the date effect depends on — which is the React
// #185 loop this component has produced before, reproduced in a test harness.
jest.mock("../../hooks/use-toast", () => {
  const toast = jest.fn();
  return { useToast: () => ({ toast }) };
});

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { endOfWeek, startOfWeek } from "date-fns";

import {
  useCalendarData,
  type UseCalendarDataOptions,
} from "../../hooks/scheduling/useCalendarData";
import { AllocationService } from "../../lib/scheduling/allocationService";

const fetchAvailabilitySlots =
  AllocationService.fetchAvailabilitySlots as jest.Mock;
const fetchConsultantData = AllocationService.fetchConsultantData as jest.Mock;

/** Mid-March, so the period bounds below sit inside the same month. */
const PERIOD_START = new Date(2026, 2, 2, 0, 0, 0, 0);
/** A Wednesday, so the week it lands in extends past it in both directions. */
const PERIOD_END = new Date(2026, 2, 18, 23, 59, 59, 999);

/** The week containing PERIOD_END — its last three days are outside the period. */
const WEEK_OF_PERIOD_END = new Date(2026, 2, 16, 12, 0, 0, 0);
/** The week AFTER the period closes: the one that used to blank entirely. */
const WEEK_AFTER_PERIOD = new Date(2026, 2, 23, 12, 0, 0, 0);

function Probe({ options }: { options: UseCalendarDataOptions }) {
  useCalendarData(options);
  return null;
}

let container: HTMLDivElement;
let root: Root;

async function renderHookWith(options: UseCalendarDataOptions) {
  await act(async () => {
    root.render(<Probe options={options} />);
  });
}

/** The (startDate, endDate) of the most recent availability request. */
function lastWindow(): { startDate: Date; endDate: Date } {
  const calls = fetchAvailabilitySlots.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const [, startDate, endDate] = calls[calls.length - 1];
  return { startDate, endDate };
}

function allocateOptions(
  currentDate: Date,
): UseCalendarDataOptions & { allowedEnd: Date } {
  return {
    consultantId: "consultant-1",
    view: "week",
    currentDate,
    mode: "allocate",
    allowedStart: PERIOD_START,
    allowedEnd: PERIOD_END,
  };
}

beforeEach(() => {
  fetchAvailabilitySlots.mockResolvedValue({ weekly: [], custom: [] });
  fetchConsultantData.mockResolvedValue({ id: "consultant-1", name: "Ada" });

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("calendar availability window — the period never narrows the view", () => {
  it("asks for the whole visible week even when it overruns allowedEnd", async () => {
    await renderHookWith(allocateOptions(WEEK_OF_PERIOD_END));

    const { startDate, endDate } = lastWindow();

    expect(startDate).toEqual(startOfWeek(WEEK_OF_PERIOD_END));
    // The property that matters: the end of the WEEK, not the end of the
    // period. The three days between them are where booked cells vanished.
    expect(endDate).toEqual(endOfWeek(WEEK_OF_PERIOD_END));
    expect(endDate.getTime()).toBeGreaterThan(PERIOD_END.getTime());
  });

  it("still asks forward for a week that starts after the period closes", async () => {
    await renderHookWith(allocateOptions(WEEK_AFTER_PERIOD));

    const { startDate, endDate } = lastWindow();

    // An inverted window is what emptied the grid: the server has no range to
    // scan, returns nothing, and every cell — booked ones included — blanks.
    expect(endDate.getTime()).toBeGreaterThan(startDate.getTime());
    expect(startDate).toEqual(startOfWeek(WEEK_AFTER_PERIOD));
    expect(endDate).toEqual(endOfWeek(WEEK_AFTER_PERIOD));
  });

  it("asks for one week's worth, not the rest of the period", async () => {
    // The old window ran from the visible week to allowedEnd, so a period with
    // months left made every navigation a months-wide scan of the endpoint
    // #997 measured in tens of seconds.
    const farOff = { ...allocateOptions(PERIOD_START), allowedEnd: new Date(2027, 0, 1) };
    await renderHookWith(farOff);

    const { startDate, endDate } = lastWindow();
    const spannedDays =
      (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000);

    expect(spannedDays).toBeLessThan(8);
  });

  it("windows a select-mode week the same way, with or without bounds", async () => {
    await renderHookWith({
      consultantId: "consultant-1",
      view: "week",
      currentDate: WEEK_OF_PERIOD_END,
      mode: "select",
    });

    const { startDate, endDate } = lastWindow();

    expect(startDate).toEqual(startOfWeek(WEEK_OF_PERIOD_END));
    expect(endDate).toEqual(endOfWeek(WEEK_OF_PERIOD_END));
  });
});
