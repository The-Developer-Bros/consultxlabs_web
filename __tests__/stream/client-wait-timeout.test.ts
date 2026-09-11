/**
 * @jest-environment node
 */

/**
 * #1134 — the meeting page could sit in a skeleton forever.
 *
 * `useGetCallById` returns early while the video client is undefined, and
 * deliberately so: the provider mounts it lazily, so `undefined` is the normal
 * cold-load state and raising an error there produced a "Video client not
 * available" flash on every open.
 *
 * But the effect re-runs only on `[client, callId, rejoinKey]`. If the client
 * never arrives — Stream unconfigured, a token fetch that keeps failing, a
 * provider that errored out — none of those change, `isCallLoading` stays true,
 * and `app/meetings/[id]/page.tsx` renders `MeetingRoomSkeleton` with no error,
 * no message and no exit. Someone waiting to be let into a session they paid
 * for watches a placeholder animate.
 *
 * The fix bounds the wait rather than removing it. The bound is the part worth
 * testing: it has to outlast the provider's own retry ladder, or it fires while
 * the provider is still retrying and would have succeeded — turning a slow
 * connect into a reported failure.
 */

import { readFileSync } from "fs";
import { join } from "path";

const hook = readFileSync(
  join(process.cwd(), "app/meetings/[id]/hooks/useGetCallById.ts"),
  "utf8",
);
const provider = readFileSync(
  join(process.cwd(), "providers/StreamProviderImpl.tsx"),
  "utf8",
);

/** The ladder StreamProviderImpl actually walks, derived from its own source. */
function providerBackoffMs(): number {
  const maxAttempts = Number(
    /currentAttempts < (\d+)/.exec(provider)?.[1] ?? NaN,
  );
  const capMs = Number(
    /Math\.min\(1000 \* Math\.pow\(2, attempt\), (\d+)\)/.exec(
      provider,
    )?.[1] ?? NaN,
  );
  expect(Number.isFinite(maxAttempts)).toBe(true);
  expect(Number.isFinite(capMs)).toBe(true);

  // Attempt n sleeps min(1000 * 2^n, cap) before retry n+1, for n = 1..max-1.
  let total = 0;
  for (let n = 1; n < maxAttempts; n++) {
    total += Math.min(1000 * 2 ** n, capMs);
  }
  return total;
}

describe("the bounded wait for the video client", () => {
  it("exists at all", () => {
    expect(hook).toContain("CLIENT_WAIT_TIMEOUT_MS");
    // The early return must survive — an immediate error is the flash this
    // deliberately avoids.
    expect(hook).toContain("if (!client) return;");
  });

  it("clears loading and sets an error when it elapses", () => {
    // Both, not just the error: `page.tsx` gates on `isCallLoading` first, so
    // an error left underneath a true loading flag renders the same skeleton.
    const block = /CLIENT_WAIT_TIMEOUT_MS\);/.exec(hook);
    expect(block).not.toBeNull();
    const timeoutBody = hook.slice(
      hook.indexOf("const timer = setTimeout"),
      hook.indexOf("CLIENT_WAIT_TIMEOUT_MS);"),
    );
    expect(timeoutBody).toContain("setError(");
    expect(timeoutBody).toContain("setIsCallLoading(false)");
  });

  it("outlasts the provider's full retry ladder", () => {
    const timeout = Number(
      /CLIENT_WAIT_TIMEOUT_MS = ([\d_]+)/
        .exec(hook)?.[1]
        .replace(/_/g, "") ?? NaN,
    );
    expect(Number.isFinite(timeout)).toBe(true);

    const backoff = providerBackoffMs();
    // 30_000ms today. A bound at or under it would report failure while the
    // provider was still working — the connect attempts themselves take time
    // on top of this, so the margin is the point.
    expect(backoff).toBeGreaterThan(0);
    expect(timeout).toBeGreaterThan(backoff);
  });

  it("cancels the timer when the client arrives", () => {
    // Otherwise a client that lands at 44s still gets an error at 45s, on top
    // of a call that resolved fine.
    expect(hook).toContain("return () => clearTimeout(timer)");
    expect(hook).toContain("if (client || !callId) return;");
  });

  it("does not fire once a client is present", () => {
    // The guard is the first statement, so a mounted-with-client render never
    // schedules anything.
    const effectStart = hook.indexOf("if (client || !callId) return;");
    const timerStart = hook.indexOf("const timer = setTimeout");
    expect(effectStart).toBeGreaterThan(-1);
    expect(timerStart).toBeGreaterThan(effectStart);
  });
});
