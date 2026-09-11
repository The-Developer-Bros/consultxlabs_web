"use client";

import { type Call, CallingState } from "@stream-io/video-react-sdk";

/**
 * Releasing the camera and microphone when someone leaves a call.
 *
 * This is a privacy path, not a tidiness one: the browser's recording
 * indicator follows live MediaStreamTracks, so a track we failed to stop
 * leaves the user's camera light on after they have visibly left the meeting,
 * believing it is off. Every leave path therefore goes through here, and
 * nothing in here is allowed to be conditional on another step succeeding.
 */

/**
 * Every local capture the SDK owns. Screen share is included unconditionally —
 * gating it on `status === "enabled"` (as the old teardown did) skipped a share
 * that was mid-negotiation, and disabling an already-disabled manager is a
 * no-op.
 */
function localDevices(call: Call) {
  // #1270 — a Call handle that never reached `get()`/`join()` has no device
  // managers yet, and teardown runs on exactly that path when a join throws.
  // (It used to run on the dashboard mint too; that mint is server-side now and
  // builds no handle at all.) Reading `.state` off an absent manager threw from
  // inside the cleanup, which then masked the real error. Teardown must never
  // be the thing that fails.
  return [call.camera, call.microphone, call.screenShare].filter(Boolean);
}

/**
 * Stops every live local track, synchronously.
 *
 * Synchronous on purpose: this is what the `pagehide` path can rely on. A
 * teardown that awaits anything first may simply never resume, because the
 * document is being torn down — and the tracks would outlive it.
 */
export function stopLocalTracks(call: Call | null | undefined): void {
  if (!call) return;

  for (const device of localDevices(call)) {
    for (const track of device.state?.mediaStream?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        // Already stopped, or the track belongs to a closed stream.
      }
    }
  }
}

/**
 * Releases every local capture, unconditionally.
 *
 * The previous teardown awaited camera, then microphone, then screen share
 * inside one try block, so the FIRST rejection skipped the rest: a camera that
 * failed to release left the microphone live and the user was already on
 * another page. `allSettled` makes each release independent of its neighbours.
 *
 * `forceStop` is asked for explicitly rather than relying on the default.
 * Both managers default to a `disableMode` of 'stop-tracks' today, but that is
 * a configurable property — being explicit means a future default of
 * 'disable-tracks' cannot silently start leaving the capture light on.
 */
export async function releaseLocalMedia(
  call: Call | null | undefined,
): Promise<void> {
  if (!call) return;

  // The async arrow matters: `allSettled` isolates a rejected PROMISE, but a
  // synchronous throw from `disable()` escapes the `.map` before there is a
  // promise to settle, skipping `stopLocalTracks` and stranding the caller —
  // with the camera still live, which is the one outcome this file exists to
  // prevent.
  await Promise.allSettled(
    localDevices(call).map(async (device) =>
      device.disable({ forceStop: true }),
    ),
  );

  // Belt and braces. Whatever the managers did or failed to do, no track the
  // call still holds may be left live — this is the state the user actually
  // observes, and the only check that matches what the browser reports.
  // `stopLocalTracks` swallows per-track failures itself, so this cannot be
  // the thing that throws.
  stopLocalTracks(call);
}

/**
 * Full teardown: release the hardware, then disconnect.
 *
 * Media goes first and happens regardless of what the disconnect does, because
 * leaving can legitimately fail — the network is gone, or the call was never
 * joined — and the camera has to go dark either way.
 */
export async function leaveCallAndReleaseMedia(
  call: Call | null | undefined,
): Promise<void> {
  if (!call) return;

  // Never allowed to reject: both exit paths await this before navigating, and
  // a rejection here would leave the user on the call screen.
  try {
    await releaseLocalMedia(call);
  } catch (error) {
    console.warn("Failed to release local media during teardown:", error);
  }

  // IDLE is the lobby-exit path: nothing was ever joined, and `leave()`
  // rejects there rather than no-opping.
  const callingState = call.state.callingState;
  if (
    callingState === CallingState.LEFT ||
    callingState === CallingState.IDLE
  ) {
    return;
  }

  try {
    await call.leave();
  } catch (error) {
    // Already reported by the SDK; the media is released either way, which is
    // the part that matters to the person who just left.
    console.warn("Failed to leave call during teardown:", error);
  }
}
