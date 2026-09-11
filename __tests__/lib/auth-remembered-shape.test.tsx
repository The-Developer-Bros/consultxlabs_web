/**
 * The navbar's optimistic first paint (#636).
 *
 * Two properties are load-bearing and neither is obvious from reading the code:
 *   1. `useRememberedAuth` MUST return null on the very first render, or the
 *      server HTML and the first client render disagree and React discards the
 *      tree. Asserted by recording every render's value.
 *   2. Once the layout effect has run, the branch must render the remembered
 *      shape instead of the skeleton.
 *
 * Paint ordering (layout effect lands before the browser paints) is a browser
 * guarantee and is deliberately NOT asserted here — it cannot be.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  forgetAuthState,
  readAuthedFlag,
  readAuthedIdentity,
  writeAuthedFlag,
} from "@/lib/auth-broadcast";
import {
  resolveAuthView,
  useRememberedAuth,
  type RememberedAuth,
} from "@/hooks/useRememberedAuth";

const IDENTITY = { name: "Zara Brown", image: "https://cdn.test/zara.png" };

describe("auth-broadcast remembered state", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips the flag and the display identity", () => {
    writeAuthedFlag(true, IDENTITY);
    expect(readAuthedFlag()).toBe(true);
    expect(readAuthedIdentity()).toEqual(IDENTITY);
  });

  it("returns null for a visitor with nothing remembered", () => {
    expect(readAuthedFlag()).toBeNull();
    expect(readAuthedIdentity()).toBeNull();
  });

  it("drops the cached identity whenever the flag goes false", () => {
    writeAuthedFlag(true, IDENTITY);
    writeAuthedFlag(false);
    expect(readAuthedFlag()).toBe(false);
    // The privacy invariant: a shared device must not retain the previous
    // user's name or avatar.
    expect(readAuthedIdentity()).toBeNull();
    expect(localStorage.getItem("familiarise.auth_identity")).toBeNull();
  });

  it("drops the cached identity when authed is written without one", () => {
    writeAuthedFlag(true, IDENTITY);
    writeAuthedFlag(true);
    expect(readAuthedIdentity()).toBeNull();
  });

  it("forgetAuthState clears both halves", () => {
    writeAuthedFlag(true, IDENTITY);
    forgetAuthState();
    expect(readAuthedFlag()).toBe(false);
    expect(readAuthedIdentity()).toBeNull();
  });

  it("clears the previous identity when the replacement write throws", () => {
    writeAuthedFlag(true, IDENTITY);
    const original = Storage.prototype.setItem;
    const spy = jest
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key: string, value: string) {
        if (key === "familiarise.auth_identity") {
          throw new Error("QuotaExceededError");
        }
        original.call(this, key, value);
      });
    try {
      writeAuthedFlag(true, { name: "Someone Else", image: null });
    } finally {
      spy.mockRestore();
    }
    // A failed write must not leave the previous account's identity behind.
    expect(readAuthedIdentity()).toBeNull();
    expect(readAuthedFlag()).toBe(false);
  });

  it("tolerates a corrupt or partial identity payload", () => {
    localStorage.setItem("familiarise.auth_authed", "true");
    localStorage.setItem("familiarise.auth_identity", "{not json");
    expect(readAuthedIdentity()).toBeNull();

    localStorage.setItem(
      "familiarise.auth_identity",
      JSON.stringify({ name: 7 }),
    );
    expect(readAuthedIdentity()).toEqual({ name: null, image: null });
  });
});

describe("resolveAuthView", () => {
  const remembered = (authed: boolean): RememberedAuth => ({
    authed,
    identity: authed ? IDENTITY : null,
  });

  it("shows the skeleton only when nothing is known", () => {
    expect(
      resolveAuthView({ isPending: true, user: null, remembered: null }).mode,
    ).toBe("unknown");
  });

  it("adopts the remembered anonymous shape while pending", () => {
    expect(
      resolveAuthView({
        isPending: true,
        user: null,
        remembered: remembered(false),
      }),
    ).toEqual({ mode: "anonymous", name: null, image: null });
  });

  it("adopts the remembered identity while pending", () => {
    expect(
      resolveAuthView({
        isPending: true,
        user: null,
        remembered: remembered(true),
      }),
    ).toEqual({ mode: "authed", ...IDENTITY });
  });

  it("lets the resolved session override a stale remembered flag", () => {
    // Expired session: remembered says authed, truth says otherwise.
    expect(
      resolveAuthView({
        isPending: false,
        user: null,
        remembered: remembered(true),
      }).mode,
    ).toBe("anonymous");
    // And the other direction — signed in on another tab.
    expect(
      resolveAuthView({
        isPending: false,
        user: { name: "Real", image: null },
        remembered: remembered(false),
      }),
    ).toEqual({ mode: "authed", name: "Real", image: null });
  });
});

describe("useRememberedAuth in a component", () => {
  let container: HTMLDivElement;
  let root: Root;
  let renders: Array<RememberedAuth | null>;

  function Harness() {
    const value = useRememberedAuth();
    renders.push(value);
    const view = resolveAuthView({
      isPending: true,
      user: null,
      remembered: value,
    });
    if (view.mode === "unknown") return <span>skeleton</span>;
    return <span>{`${view.mode}:${view.name ?? ""}`}</span>;
  }

  beforeEach(() => {
    localStorage.clear();
    renders = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the remembered identity instead of the skeleton", () => {
    writeAuthedFlag(true, IDENTITY);
    act(() => root.render(<Harness />));

    // Hydration safety: nothing was read from localStorage during the first
    // render, so the server markup and the first client render match.
    expect(renders[0]).toBeNull();
    expect(renders.at(-1)).toEqual({ authed: true, identity: IDENTITY });
    expect(container.textContent).toBe("authed:Zara Brown");
  });

  it("renders the signed-out shape for a remembered anonymous visitor", () => {
    writeAuthedFlag(false);
    act(() => root.render(<Harness />));
    expect(container.textContent).toBe("anonymous:");
  });

  it("keeps the skeleton when nothing is remembered", () => {
    act(() => root.render(<Harness />));
    expect(renders).toEqual([null]);
    expect(container.textContent).toBe("skeleton");
  });
});
