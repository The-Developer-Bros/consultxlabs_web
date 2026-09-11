/**
 * #1067 — the lobby gained an explicit way out, and a new exit is a new way to
 * leave the camera light on.
 *
 * The camera-stays-on defect this PR fixed came from exits that did not run
 * the teardown, so the assertion that matters here is not that the button
 * navigates: it is that `leaveCallAndReleaseMedia` runs, and runs BEFORE the
 * navigation, on the same call the lobby is showing. A visual check would
 * never catch this — the page looks correct either way and only the hardware
 * indicator disagrees.
 */

// Silences React's "not wrapped in act" warning; every render here is.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const push = jest.fn();
const leaveCallAndReleaseMedia = jest.fn(() => Promise.resolve());
let sessionUser: Record<string, unknown> | null = null;
const call = { id: "slot-A" };

jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
jest.mock("@stream-io/video-react-sdk", () => ({ useCall: () => call }));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: sessionUser ? { user: sessionUser } : null }),
}));
jest.mock("../../lib/stream/media-teardown", () => ({
  leaveCallAndReleaseMedia: (...args: unknown[]) =>
    leaveCallAndReleaseMedia(...(args as [])),
}));

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ExitMeetingButton } from "../../app/meetings/[id]/components/ExitMeetingButton";
import { resolveAppointmentsHref } from "../../lib/labels/personal-dashboard";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // Reset, not clear: an implementation set by one test (a rejecting teardown,
  // an order-recording push) otherwise leaks into every test after it.
  push.mockReset();
  leaveCallAndReleaseMedia.mockReset();
  leaveCallAndReleaseMedia.mockResolvedValue(undefined);
  sessionUser = { consultantProfileId: "cp-1" };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render() {
  act(() => {
    root.render(<ExitMeetingButton />);
  });
  const button = host.querySelector("button");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("exit control not rendered");
  }
  return button;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
  });
}

describe("leaving the lobby releases the camera and microphone", () => {
  it("runs the shared teardown on the call it is showing", async () => {
    await click(render());

    expect(leaveCallAndReleaseMedia).toHaveBeenCalledTimes(1);
    expect(leaveCallAndReleaseMedia).toHaveBeenCalledWith(call);
  });

  it("releases BEFORE navigating away", async () => {
    // Order is the whole point: navigating first unmounts this tree, and a
    // teardown that never got to run is exactly the original defect.
    const order: string[] = [];
    leaveCallAndReleaseMedia.mockImplementation(() => {
      order.push("release");
      return Promise.resolve();
    });
    push.mockImplementation(() => {
      order.push("navigate");
    });

    await click(render());

    expect(order).toEqual(["release", "navigate"]);
  });

  it("still leaves when the teardown fails", async () => {
    // The media path swallows its own failures; stranding the user in a lobby
    // they asked to leave would be the worse outcome.
    leaveCallAndReleaseMedia.mockImplementation(() =>
      Promise.reject(new Error("device busy")),
    );
    const warned = jest.spyOn(console, "warn").mockImplementation(() => {});

    await click(render());

    expect(push).toHaveBeenCalledTimes(1);
    warned.mockRestore();
  });

  it("does not fire twice on a double click", async () => {
    const button = render();
    await act(async () => {
      button.click();
      button.click();
    });

    expect(leaveCallAndReleaseMedia).toHaveBeenCalledTimes(1);
  });
});

describe("where it goes back to", () => {
  it("sends a consultant to their own appointments", async () => {
    sessionUser = { consultantProfileId: "cp-1" };
    await click(render());
    expect(push).toHaveBeenCalledWith(
      "/dashboard/consultant/cp-1/appointments",
    );
  });

  it("sends a consultee to theirs", async () => {
    sessionUser = { consulteeProfileId: "ce-9" };
    await click(render());
    expect(push).toHaveBeenCalledWith("/dashboard/consultee/ce-9/appointments");
  });

  it("prefers the delivering side for someone who is both", async () => {
    sessionUser = { consultantProfileId: "cp-1", consulteeProfileId: "ce-9" };
    await click(render());
    expect(push).toHaveBeenCalledWith(
      "/dashboard/consultant/cp-1/appointments",
    );
  });

  it("never sends an org member to an appointments route that does not exist", () => {
    // org-workspace wins in resolvePersonalDashboardHref but has no
    // appointments surface, so it must NOT win here.
    expect(resolveAppointmentsHref({ orgWorkspaceProfileId: "ow-1" })).toBe(
      "/dashboard/org-workspace/ow-1/home",
    );
  });

  it("always resolves somewhere, even with no profile at all", async () => {
    sessionUser = {};
    await click(render());
    expect(push).toHaveBeenCalledWith("/dashboard");
  });
});
