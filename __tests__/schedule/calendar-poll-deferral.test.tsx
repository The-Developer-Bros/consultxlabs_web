// #1164 — the background poll must never race the navigation fetch.
//
// Both go through the same request-id guard: the newest id wins and every
// older response is dropped, including in its `finally`. That is right for the
// responses, but the poll ISSUING a request is what breaks it. A first load
// slower than the 60s interval — the shape #997 measured in tens of seconds,
// and a cold instance boot makes worse — let the poll bump the id out from
// under the navigation fetch. The navigation fetch then skipped its guarded
// `setLoading(false)`, and the background request never touches `loading` at
// all, so the grid sat on its skeleton until the user navigated again.
//
// The assertions are on the CALL COUNT and on `loading`, not on rendered
// cells: nothing about how a slot draws could have caught a request that was
// merely issued at the wrong moment.

jest.mock("../../lib/scheduling/allocationService", () => ({
  AllocationService: {
    fetchAvailabilitySlots: jest.fn(),
    fetchConsultantData: jest.fn(),
    fetchEventSlots: jest.fn(),
  },
}));

// ONE toast function for the life of the module — a fresh `jest.fn()` per call
// would change `toast`'s identity every render, and `toast` is a dependency of
// the fetch callback both effects key on (the React #185 loop, in a harness).
jest.mock("../../hooks/use-toast", () => {
  const toast = jest.fn();
  return { useToast: () => ({ toast }) };
});

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  useCalendarData,
  type UseCalendarDataOptions,
} from "../../hooks/scheduling/useCalendarData";
import { AVAILABILITY_POLL_INTERVAL_MS } from "../../lib/scheduling/availabilityPolling";
import { AllocationService } from "../../lib/scheduling/allocationService";

const fetchAvailabilitySlots =
  AllocationService.fetchAvailabilitySlots as jest.Mock;
const fetchConsultantData = AllocationService.fetchConsultantData as jest.Mock;

type SlotResponse = { weekly: never[]; custom: never[] };

const EMPTY_RESPONSE: SlotResponse = { weekly: [], custom: [] };

/** A Wednesday, so nothing about the window under test is a boundary case. */
const CURRENT_DATE = new Date(2026, 2, 18, 12, 0, 0, 0);

const OPTIONS: UseCalendarDataOptions = {
  consultantId: "consultant-1",
  view: "week",
  currentDate: CURRENT_DATE,
  mode: "select",
};

let latest: ReturnType<typeof useCalendarData> | null = null;

function Probe({ options }: { options: UseCalendarDataOptions }) {
  latest = useCalendarData(options);
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fetchAvailabilitySlots.mockResolvedValue(EMPTY_RESPONSE);
  fetchConsultantData.mockResolvedValue({ id: "consultant-1", name: "Ada" });

  // React's async `act` flushes its work through the microtask/immediate
  // queues; faking those deadlocks every `await act` below. Only the poll's
  // `setTimeout` and the `Date.now` staleness stamp need to be under control.
  jest.useFakeTimers({
    doNotFake: ["queueMicrotask", "setImmediate", "nextTick"],
  });

  latest = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe("availability polling — a poll never races the fetch in flight", () => {
  it("defers past the poll interval and still clears the skeleton", async () => {
    // A navigation fetch that outlives the poll interval.
    let settleNavigationFetch: (value: SlotResponse) => void = () => {};
    fetchAvailabilitySlots.mockReturnValueOnce(
      new Promise<SlotResponse>((resolve) => {
        settleNavigationFetch = resolve;
      }),
    );

    await act(async () => {
      root.render(<Probe options={OPTIONS} />);
    });

    expect(fetchAvailabilitySlots).toHaveBeenCalledTimes(1);
    expect(latest?.loading).toBe(true);

    // The poll comes due while that first request is still out.
    await act(async () => {
      jest.advanceTimersByTime(AVAILABILITY_POLL_INTERVAL_MS + 1_000);
    });

    // It must not have issued anything: a second request here bumps the id and
    // strands the navigation fetch's guarded `setLoading(false)`.
    expect(fetchAvailabilitySlots).toHaveBeenCalledTimes(1);
    expect(latest?.loading).toBe(true);

    await act(async () => {
      settleNavigationFetch(EMPTY_RESPONSE);
    });

    // The skeleton clears — the failure this guard exists to prevent.
    expect(latest?.loading).toBe(false);
  });

  it("re-arms the deferred poll behind the fetch it waited for", async () => {
    let settleNavigationFetch: (value: SlotResponse) => void = () => {};
    fetchAvailabilitySlots.mockReturnValueOnce(
      new Promise<SlotResponse>((resolve) => {
        settleNavigationFetch = resolve;
      }),
    );

    await act(async () => {
      root.render(<Probe options={OPTIONS} />);
    });
    await act(async () => {
      jest.advanceTimersByTime(AVAILABILITY_POLL_INTERVAL_MS + 1_000);
    });
    await act(async () => {
      settleNavigationFetch(EMPTY_RESPONSE);
    });

    // Deferred, not dropped: a full interval has elapsed since the request was
    // issued, so the wait ends in a poll rather than another idle interval.
    await act(async () => {
      jest.advanceTimersByTime(1);
    });

    expect(fetchAvailabilitySlots).toHaveBeenCalledTimes(2);
  });

  it("polls on schedule when nothing is in flight", async () => {
    await act(async () => {
      root.render(<Probe options={OPTIONS} />);
    });

    expect(fetchAvailabilitySlots).toHaveBeenCalledTimes(1);
    expect(latest?.loading).toBe(false);

    await act(async () => {
      jest.advanceTimersByTime(AVAILABILITY_POLL_INTERVAL_MS);
    });

    // The deferral must not have cost the ordinary cadence its tick.
    expect(fetchAvailabilitySlots).toHaveBeenCalledTimes(2);
  });
});
