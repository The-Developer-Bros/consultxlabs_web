"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Call, useStreamVideoClient } from "@stream-io/video-react-sdk";

import { streamLogger } from "@/lib/stream-logger";
import { leaveCallAndReleaseMedia } from "@/lib/stream/media-teardown";

export interface MeetingAccessResult {
  hasAccess: boolean;
  role: "host" | "participant" | null;
  message: string;
}

/** What the participant had on when the connection died, so a rejoin restores it. */
interface DeviceSnapshot {
  microphone: boolean;
  camera: boolean;
}

/**
 * Resolve the Stream call for a meeting id, gated by the server.
 *
 * #1134 P0-2 — this used to `client.queryCalls()` and, on a miss,
 * `client.call("default", callId).getOrCreate()`. That ran in PARALLEL with the
 * access check on the page, so any signed-in user who opened
 * `/meetings/<anything>` minted a billable Stream call and became its
 * `created_by` before being shown "Access Denied". Two such ghosts —
 * `default:smoke-test-nonexistent` and `default:test-meeting` — were still
 * sitting in the production app months later.
 *
 * The client no longer creates anything. It asks `/api/meetings/[id]/join`,
 * which grants call membership only after confirming the caller is on this
 * appointment. A non-participant gets a 403 with no Stream object created, and —
 * with `join-call` moved to `call_member` — could not join even holding a call
 * handle. `client.call()` below constructs a local object and writes nothing.
 *
 * `rejoin()` is the manual recovery from `RECONNECTING_FAILED` and `LEFT`, both
 * of which are terminal for a Call instance: the SDK requires a NEW one. It
 * bumps a nonce in the effect deps, so recovery goes back through the join route
 * rather than around it — that route is what grants Stream membership, and
 * `call.join()` on a fresh handle without it would be refused by Stream itself.
 */
/**
 * How long to wait for the video client before calling it a failure.
 *
 * Sized against the provider, not picked round: `StreamProviderImpl` retries up
 * to five times with `min(1000 * 2^n, 30_000)` backoff, so its ladder is
 * 2 + 4 + 8 + 16 = 30 seconds of waiting plus the connect attempts themselves.
 * A shorter bound would fire while the provider was still legitimately retrying
 * and would have succeeded. This only elapses once it has genuinely given up,
 * or never started.
 */
const CLIENT_WAIT_TIMEOUT_MS = 45_000;

export const useGetCallById = (callId: string) => {
  const [call, setCall] = useState<Call | null>(null);
  const [isCallLoading, setIsCallLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [access, setAccess] = useState<MeetingAccessResult | null>(null);
  const [rejoinKey, setRejoinKey] = useState(0);
  const client = useStreamVideoClient();

  // The call being replaced, and the devices it was using. Refs rather than
  // deps: reading them must not re-run the resolution effect.
  const previousCall = useRef<Call | null>(null);
  const deviceSnapshot = useRef<DeviceSnapshot | null>(null);

  const rejoin = useCallback(() => {
    const current = previousCall.current;
    if (current) {
      // Rejoining must not silently switch the camera back on for someone who
      // had turned it off. The fresh instance starts from the call type's
      // defaults, so the previous choice is carried across by hand.
      deviceSnapshot.current = {
        microphone: current.microphone.state.status === "enabled",
        camera: current.camera.state.status === "enabled",
      };
    }
    setRejoinKey((key) => key + 1);
  }, []);

  /**
   * The client may never arrive — Stream unconfigured, a token fetch that keeps
   * failing, a provider that errored out. The resolution effect below returns
   * early in that case and re-runs only when `client` or `callId` changes, so
   * `isCallLoading` stayed true forever and `page.tsx` rendered
   * `MeetingRoomSkeleton` with no error, no message and no way out.
   *
   * Waiting is still the right default — see the comment on the early return —
   * so this bounds the wait rather than removing it.
   */
  useEffect(() => {
    if (client || !callId) return;

    const timer = setTimeout(() => {
      setError(
        new Error(
          "Could not connect to the video service. Check your connection and try again.",
        ),
      );
      setIsCallLoading(false);
    }, CLIENT_WAIT_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [client, callId]);

  useEffect(() => {
    if (!callId) {
      setError(new Error("Call ID is required"));
      setIsCallLoading(false);
      return;
    }
    // The provider mounts the video client lazily, so `undefined` here is the
    // normal cold-load state, not a failure. Stay in `loading` and let the
    // effect re-run once the client lands — surfacing an error at this point
    // produced a visible "Video client not available" flash on every cold open.
    if (!client) return;

    // Guards a slow response for a previous `callId` from overwriting a newer
    // one, and a `setState` after unmount.
    let cancelled = false;

    // #1270 — `callInstance.get()` below applies the call type's
    // camera_default_on/mic_default_on, so the devices are LIVE from that line
    // on. Every exit that does not hand the instance to state — a `cancelled`
    // bail, a throw, an unmount mid-flight — used to drop the only reference to
    // it and leave the camera light on for the life of the tab.
    //
    // Declared out here so the effect's cleanup can release an instance whose
    // `get()`/`join()` is still pending. The handle is deliberately NOT cleared
    // on release: `applyDeviceConfig` runs at the TAIL of `get()`, so a cleanup
    // that fires mid-flight can release devices that are then re-enabled a
    // moment later. Keeping the handle lets the `finally` — which runs after
    // `get()` settles — release them again. Teardown is idempotent, and being
    // called twice is much cheaper than the leak.
    let inFlight: Call | null = null;
    let adopted = false;
    const releaseIfUnadopted = async () => {
      if (!adopted && inFlight) await leaveCallAndReleaseMedia(inFlight);
    };

    const run = async () => {
      setIsCallLoading(true);
      setError(null);

      const isRejoin = rejoinKey > 0;

      try {
        // Release the dead instance BEFORE acquiring a new one, so the camera
        // is not held twice on the same device across the swap.
        if (isRejoin && previousCall.current) {
          await leaveCallAndReleaseMedia(previousCall.current);
        }

        const response = await fetch(
          `/api/meetings/${encodeURIComponent(callId)}/join`,
          { method: "POST" },
        );

        if (cancelled) return;

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          const message =
            typeof body?.error === "string"
              ? body.error
              : "Could not join this meeting.";

          // Only an authorization verdict is an access denial. Everything else
          // — Stream down (503), a server fault (500), a bad id (400) — used to
          // land here too and render as "You are not authorized to join this
          // meeting", telling a legitimate participant they had been refused
          // when the truth was an outage.
          const refused =
            response.status === 401 ||
            response.status === 403 ||
            response.status === 404;

          if (refused) {
            setAccess({ hasAccess: false, role: null, message });
            setCall(null);
            previousCall.current = null;
            // Not an `error`: a refusal is an expected outcome with its own UI,
            // and rendering it as a crash lost the reason.
            return;
          }

          // A failure, not a verdict. Surfacing it as an error gets the retry
          // affordance instead of a dead-end "access denied" screen. The catch
          // below clears `previousCall`, so it is not repeated here.
          throw new Error(message);
        }

        const data = (await response.json()) as {
          callType: string;
          callId: string;
          role: "host" | "participant";
        };

        if (cancelled) return;

        // `client.call()` only constructs the local handle — it performs no
        // network write, so nothing is created for a caller who got this far.
        const callInstance = client.call(data.callType, data.callId);
        inFlight = callInstance;
        await callInstance.get();

        if (cancelled) return;

        // A rejoin lands the person back where they were. The first resolve
        // does NOT join: that is the lobby's decision, and it is where the
        // recording notice is consented to.
        if (isRejoin) {
          await callInstance.join();
          await restoreDevices(callInstance, deviceSnapshot.current);
        }

        if (cancelled) return;

        setAccess({
          hasAccess: true,
          role: data.role,
          message: "Access granted",
        });
        previousCall.current = callInstance;
        setCall(callInstance);
        adopted = true;
      } catch (err) {
        if (cancelled) return;
        streamLogger.error("Failed to resolve meeting call", err, { callId });
        setError(err instanceof Error ? err : new Error("Failed to get call"));
        setCall(null);
        previousCall.current = null;
      } finally {
        // Anything still in flight here was never handed to state, so nothing
        // else can ever release it.
        await releaseIfUnadopted();
        if (!cancelled) setIsCallLoading(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
      // Do not wait for the in-flight SDK call to settle before cutting
      // capture — the user has already navigated away.
      void releaseIfUnadopted();
    };
  }, [client, callId, rejoinKey]);

  return { call, isCallLoading, error, access, rejoin };
};

/**
 * Puts the microphone and camera back the way the participant left them.
 *
 * Settled independently: a camera that refuses to come back must not be the
 * reason the microphone stays off, and neither may fail the rejoin — being
 * reconnected with the wrong device state still beats not being reconnected.
 */
async function restoreDevices(
  call: Call,
  snapshot: DeviceSnapshot | null,
): Promise<void> {
  if (!snapshot) return;

  const results = await Promise.allSettled([
    snapshot.microphone ? call.microphone.enable() : call.microphone.disable(),
    snapshot.camera ? call.camera.enable() : call.camera.disable(),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      streamLogger.warn("Could not restore a device after rejoin", {
        reason: String(result.reason),
      });
    }
  }
}
