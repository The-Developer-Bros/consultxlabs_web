import {
  getStreamChatClient,
  isStreamConfigured,
  StreamUnavailableError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";

/**
 * #1280 / #1146 — the probe needs a deadline of its own.
 *
 * The chat client is a singleton built with one global `timeout: 30000`
 * (`lib/stream-client.ts`), `getAppSettings()` takes no arguments so there is no
 * per-request timeout or `AbortSignal` to narrow, and the circuit breaker's only
 * timing knob is `resetTimeout`, which governs OPEN→HALF_OPEN rather than the
 * operation. So the breaker delivers exactly the protection this file's docblock
 * promises for the SECOND probe of an outage and none at all for the first: in
 * the opening minutes, before enough failures accumulate, `/api/health` could
 * hang for a full thirty seconds on the endpoint whose entire purpose is to
 * report that outage quickly.
 *
 * Two seconds. A healthy `getAppSettings` is tens of milliseconds, and a health
 * check that takes longer than a couple of seconds has already failed at its job
 * whatever it eventually returns.
 */
const PROBE_TIMEOUT_MS = 2_000;

class StreamProbeTimeout extends Error {
  constructor() {
    super(`Stream health probe exceeded ${PROBE_TIMEOUT_MS}ms`);
    this.name = "StreamProbeTimeout";
  }
}

/**
 * Race `operation` against a deadline.
 *
 * Deliberately INSIDE the breaker rather than around it. A caller-side race
 * would return early and leave the breaker none the wiser, so the probe would
 * time out every time for the whole outage and never trip the thing that makes
 * subsequent probes cheap. Rejecting from within means the timeout counts as a
 * breaker failure, which is the entire point.
 *
 * It does not cancel the in-flight SDK request — `getAppSettings` exposes no
 * signal to cancel it with. The request is left to settle and its result
 * discarded. That is an accepted leak of one socket per probe during an outage,
 * and far cheaper than a 30-second health check.
 */
async function withDeadline<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new StreamProbeTimeout()),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface StreamHealth {
  configured: boolean;
  /** null when unconfigured — we never probed, so we do not know. */
  reachable: boolean | null;
  /** True when Stream's circuit breaker is OPEN and we fast-failed. */
  breakerOpen: boolean;
  /** True when the probe hit its own deadline rather than erroring. */
  timedOut?: boolean;
  latencyMs?: number;
}

/**
 * #473 — the health endpoint's Stream probe.
 *
 * The circuit breaker landed without anything reporting its state, so a Stream
 * outage stayed invisible until a user noticed chat was dead. This gives the
 * external monitor something to alert on, and — because the probe goes through
 * the breaker — an already-open breaker answers in microseconds rather than
 * making the health check itself hang for 30 seconds during the outage it is
 * supposed to be reporting.
 *
 * `getAppSettings` is the cheapest authenticated round-trip Stream offers: it
 * touches no user or channel data.
 */
export async function getStreamStatus(): Promise<StreamHealth> {
  if (!isStreamConfigured()) {
    return { configured: false, reachable: null, breakerOpen: false };
  }

  const startedAt = Date.now();
  try {
    await withStreamCircuitBreaker(() =>
      withDeadline(() => getStreamChatClient().getAppSettings()),
    );
    return {
      configured: true,
      reachable: true,
      breakerOpen: false,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      breakerOpen: error instanceof StreamUnavailableError,
      timedOut: error instanceof StreamProbeTimeout,
      latencyMs: Date.now() - startedAt,
    };
  }
}
