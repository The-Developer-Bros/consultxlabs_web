/**
 * Search told two lies, and both were about time rather than data.
 *
 * 1. "No results found for michael" rendered while Michael Chen sat in the list
 *    underneath. The empty state was gated on `!loading`, but `setLoading(true)`
 *    runs INSIDE the search, which fires 300ms after the keystroke — so for that
 *    whole window `loading` was false and no request existed yet. It announced
 *    failure before it had looked, on every keystroke.
 *
 * 2. An empty search box with a stale result still listed. There was no
 *    `AbortController` and no latest-wins guard, so `setSearchResults` committed
 *    whichever response landed last regardless of which query it answered.
 *
 * Both are invisible to a test that resolves fetches in order, which is why
 * these deliberately resolve them OUT of order and assert on the settled DOM.
 */

// Silences React's "not wrapped in act" warning; every render here is.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const setActiveChannel = jest.fn();
const openConversation = jest.fn();

jest.mock("stream-chat-react", () => ({
  useChatContext: () => ({
    client: { userID: "me", channel: jest.fn() },
    setActiveChannel,
  }),
}));
jest.mock("../../components/chat/ChatPaneContext", () => ({
  useChatPane: () => ({ openConversation }),
}));
jest.mock("next/image", () => ({
  __esModule: true,
  default: () => null,
}));

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ChannelSearch } from "../../components/chat/ChannelSearch";

let host: HTMLDivElement;
let root: Root;

/** A consultation row as the search route returns it. */
function row(name: string, channelId: string) {
  return {
    id: `${channelId}-id`,
    type: "consultation" as const,
    name: `${name}'s plan`,
    counterpartyName: name,
    counterpartyUserId: `${channelId}-user`,
    organizationId: null,
    channelId,
  };
}

/** A fetch whose responses resolve only when the test says so. */
function deferredFetch() {
  const pending: Array<{
    query: string;
    resolve: (rows: ReturnType<typeof row>[]) => void;
  }> = [];

  const fetchMock = jest.fn((url: string, init?: RequestInit) => {
    const query = new URL(url, "http://localhost").searchParams.get("q") ?? "";
    return new Promise((resolve, reject) => {
      // `new DOMException(msg, name)` already sets `.name`. Do NOT then
      // `Object.assign` it — `name` is a getter-only accessor on the prototype,
      // so writing to it throws a TypeError in strict mode, the listener dies,
      // the promise never rejects, and the test "fails" against perfectly
      // correct component code.
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
      pending.push({
        query,
        resolve: (rows) =>
          resolve({ ok: true, json: async () => rows } as Response),
      });
    });
  });

  return { fetchMock, pending };
}

async function type(value: string) {
  const input = host.querySelector("input") as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Advance past the 300ms debounce and let promises flush. */
async function settleDebounce() {
  await act(async () => {
    jest.advanceTimersByTime(350);
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("the empty state does not fire before a search has run", () => {
  it("stays silent during the debounce window", async () => {
    const { fetchMock } = deferredFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => root.render(<ChannelSearch />));
    await type("michael");

    // Mid-debounce: the request has not been issued yet.
    expect(fetchMock).not.toHaveBeenCalled();
    // This is the reported bug — the box claimed there was nothing to find
    // before it had looked.
    expect(host.textContent).not.toContain("No results found");
  });

  it("stays silent while the request is in flight", async () => {
    const { fetchMock } = deferredFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => root.render(<ChannelSearch />));
    await type("michael");
    await settleDebounce();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain("No results found");
  });

  it("shows it only once a search has genuinely returned nothing", async () => {
    const { fetchMock, pending } = deferredFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => root.render(<ChannelSearch />));
    await type("michael");
    await settleDebounce();

    await act(async () => {
      pending[0].resolve([]);
      await Promise.resolve();
    });

    expect(host.textContent).toContain("No results found");
  });
});

describe("out-of-order responses", () => {
  it("ignores a stale response that lands after a newer one", async () => {
    const { fetchMock, pending } = deferredFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => root.render(<ChannelSearch />));

    await type("chen");
    await settleDebounce();
    await type("michael");
    await settleDebounce();

    expect(pending).toHaveLength(2);
    expect(pending[0].query).toBe("chen");
    expect(pending[1].query).toBe("michael");

    // Newer first, then the stale one — the order that used to repaint the
    // dropdown with results for a query the user had already moved off.
    await act(async () => {
      pending[1].resolve([row("Michael Chen", "dm-a-michael")]);
      await Promise.resolve();
    });
    await act(async () => {
      pending[0].resolve([row("Samantha Chen", "dm-a-samantha")]);
      await Promise.resolve();
    });

    expect(host.textContent).toContain("Michael Chen");
    expect(host.textContent).not.toContain("Samantha Chen");
  });

  it("aborts the previous request when a new one starts", async () => {
    const { fetchMock } = deferredFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => root.render(<ChannelSearch />));

    await type("chen");
    await settleDebounce();
    await type("michael");
    await settleDebounce();

    const firstSignal = (fetchMock.mock.calls[0][1] as RequestInit).signal;
    expect(firstSignal?.aborted).toBe(true);
  });

  it("does not repopulate the dropdown after the query is cleared", async () => {
    const { fetchMock, pending } = deferredFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => root.render(<ChannelSearch />));

    await type("samantha");
    await settleDebounce();

    // Clear the box, then let the earlier response arrive. This is the reported
    // screenshot: an empty search field with a result still listed under it.
    await type("");
    await settleDebounce();

    await act(async () => {
      pending[0].resolve([row("Samantha Chen", "dm-a-samantha")]);
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain("Samantha Chen");
  });
});

describe("what matched is visible", () => {
  it("shows the plan title, not just the counterparty", async () => {
    const { fetchMock, pending } = deferredFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => root.render(<ChannelSearch />));
    await type("michael");
    await settleDebounce();

    // The route matches plan titles too, so a row can match on something the
    // UI never displayed — which reads as a wrong result.
    await act(async () => {
      pending[0].resolve([row("Robert Brown", "dm-a-robert")]);
      await Promise.resolve();
    });

    expect(host.textContent).toContain("Robert Brown");
    expect(host.textContent).toContain("Robert Brown's plan");
  });
});
