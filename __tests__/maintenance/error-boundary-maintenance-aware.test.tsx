// #1554-follow — the error boundary used to show the generic "Something went
// wrong" card underneath the DEGRADED banner and navigation, with no hint that
// an active maintenance phase was the cause. It now checks the maintenance-
// exempt /api/health endpoint once on mount and swaps in the maintenance
// message for DEGRADED/OFFLINE, keeping the generic card for OFF.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("next/image", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
}));

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import GlobalError from "../../app/error";

const ERROR = Object.assign(new Error("boom"), { digest: "abc123" });

let container: HTMLDivElement;
let root: Root;

function flush() {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (global as { fetch?: unknown }).fetch;
  jest.restoreAllMocks();
});

describe("app/error.tsx — maintenance-aware rendering", () => {
  it.each(["DEGRADED", "OFFLINE"])(
    "renders the maintenance message when /api/health reports %s",
    async (phase) => {
      global.fetch = jest.fn().mockResolvedValue({
        json: async () => ({
          maintenance: {
            phase,
            reason: "Rolling out a schema change.",
            estimatedEnd: null,
          },
        }),
      }) as unknown as typeof fetch;

      await act(async () => {
        root.render(<GlobalError error={ERROR} reset={() => {}} />);
      });
      await flush();

      expect(
        container.querySelector('[data-testid="maintenance-error"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="generic-error"]'),
      ).toBeNull();
      expect(container.textContent).toContain(
        "We're doing scheduled maintenance",
      );
      expect(container.textContent).toContain("Rolling out a schema change.");
    },
  );

  it("renders the generic card when /api/health reports OFF", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        maintenance: { phase: "OFF", reason: null, estimatedEnd: null },
      }),
    }) as unknown as typeof fetch;

    await act(async () => {
      root.render(<GlobalError error={ERROR} reset={() => {}} />);
    });
    await flush();

    expect(
      container.querySelector('[data-testid="generic-error"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="maintenance-error"]'),
    ).toBeNull();
    expect(container.textContent).toContain("Something went wrong");
    // The generic card is the initial state, so the effect must be shown to
    // have asked before the test proves anything.
    expect(global.fetch).toHaveBeenCalledWith("/api/health");
  });

  it("renders the generic card when the health call fails", async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    await act(async () => {
      root.render(<GlobalError error={ERROR} reset={() => {}} />);
    });
    await flush();

    expect(
      container.querySelector('[data-testid="generic-error"]'),
    ).not.toBeNull();
    expect(global.fetch).toHaveBeenCalledWith("/api/health");
  });
});
