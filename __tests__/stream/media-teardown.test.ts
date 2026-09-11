/**
 * @jest-environment node
 */

/**
 * Leaving a meeting has to release the camera and the microphone every time.
 *
 * The browser's recording indicator follows live MediaStreamTracks, so a track
 * we fail to stop leaves the user's camera light on after they have visibly
 * left — believing it is off. The old teardown awaited camera, then
 * microphone, then screen share in one try block, so the first rejection
 * silently skipped the rest. These pin that it cannot happen again.
 */

jest.mock("@stream-io/video-react-sdk", () => ({
  __esModule: true,
  CallingState: {
    UNKNOWN: "unknown",
    IDLE: "idle",
    RINGING: "ringing",
    JOINING: "joining",
    JOINED: "joined",
    LEFT: "left",
    RECONNECTING: "reconnecting",
    MIGRATING: "migrating",
    OFFLINE: "offline",
    RECONNECTING_FAILED: "reconnecting-failed",
  },
}));

import type { Call } from "@stream-io/video-react-sdk";
import {
  leaveCallAndReleaseMedia,
  releaseLocalMedia,
  stopLocalTracks,
} from "@/lib/stream/media-teardown";

type FakeTrack = { stop: jest.Mock };

function fakeDevice(opts: { disable?: jest.Mock; tracks?: FakeTrack[] } = {}) {
  const tracks = opts.tracks ?? [{ stop: jest.fn() }];
  return {
    disable: opts.disable ?? jest.fn().mockResolvedValue(undefined),
    state: { mediaStream: { getTracks: () => tracks } },
    tracks,
  };
}

function fakeCall(
  overrides: {
    camera?: ReturnType<typeof fakeDevice>;
    microphone?: ReturnType<typeof fakeDevice>;
    screenShare?: ReturnType<typeof fakeDevice>;
    callingState?: string;
    leave?: jest.Mock;
  } = {},
) {
  const camera = overrides.camera ?? fakeDevice();
  const microphone = overrides.microphone ?? fakeDevice();
  const screenShare = overrides.screenShare ?? fakeDevice();
  const leave = overrides.leave ?? jest.fn().mockResolvedValue(undefined);
  return {
    camera,
    microphone,
    screenShare,
    leave,
    state: { callingState: overrides.callingState ?? "joined" },
  };
}

const asCall = (call: ReturnType<typeof fakeCall>) => call as unknown as Call;

describe("releaseLocalMedia", () => {
  it("force-stops every capture rather than relying on the disable default", async () => {
    const call = fakeCall();
    await releaseLocalMedia(asCall(call));

    for (const device of [call.camera, call.microphone, call.screenShare]) {
      expect(device.disable).toHaveBeenCalledWith({ forceStop: true });
    }
  });

  it("releases the microphone even when the camera refuses to release", async () => {
    const camera = fakeDevice({
      disable: jest.fn().mockRejectedValue(new Error("camera busy")),
    });
    const call = fakeCall({ camera });

    await expect(releaseLocalMedia(asCall(call))).resolves.toBeUndefined();

    // The regression: these two were awaited after the camera in one try, so a
    // camera that threw took the microphone and screen share down with it.
    expect(call.microphone.disable).toHaveBeenCalled();
    expect(call.screenShare.disable).toHaveBeenCalled();
  });

  it("stops the screen share without asking whether it looked enabled", async () => {
    // The old code gated this on `status === "enabled"`, which missed a share
    // caught mid-negotiation.
    const call = fakeCall();
    await releaseLocalMedia(asCall(call));
    expect(call.screenShare.disable).toHaveBeenCalled();
  });

  it("stops any track a manager left live", async () => {
    const stray = { stop: jest.fn() };
    const camera = fakeDevice({
      disable: jest.fn().mockResolvedValue(undefined),
      tracks: [stray],
    });
    await releaseLocalMedia(asCall(fakeCall({ camera })));
    expect(stray.stop).toHaveBeenCalled();
  });

  it("does nothing, and does not throw, without a call", async () => {
    await expect(releaseLocalMedia(null)).resolves.toBeUndefined();
    expect(() => stopLocalTracks(undefined)).not.toThrow();
  });
});

describe("leaveCallAndReleaseMedia", () => {
  it("releases the hardware and then disconnects", async () => {
    const call = fakeCall();
    await leaveCallAndReleaseMedia(asCall(call));

    expect(call.camera.disable).toHaveBeenCalled();
    expect(call.leave).toHaveBeenCalled();
  });

  it("still releases the hardware when leaving fails", async () => {
    const call = fakeCall({
      leave: jest.fn().mockRejectedValue(new Error("offline")),
    });

    await expect(
      leaveCallAndReleaseMedia(asCall(call)),
    ).resolves.toBeUndefined();
    expect(call.camera.disable).toHaveBeenCalledWith({ forceStop: true });
    expect(call.microphone.disable).toHaveBeenCalledWith({ forceStop: true });
  });

  it.each(["idle", "left"])(
    "does not try to leave a call in state %s",
    async (callingState) => {
      const call = fakeCall({ callingState });
      await leaveCallAndReleaseMedia(asCall(call));

      // Exiting the lobby never joined anything; `leave()` rejects there.
      expect(call.leave).not.toHaveBeenCalled();
      // The media still has to go.
      expect(call.camera.disable).toHaveBeenCalled();
    },
  );
});
