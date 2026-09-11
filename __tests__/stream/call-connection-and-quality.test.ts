/**
 * @jest-environment node
 */

/**
 * #1134 — the meeting room collapsed every non-JOINED state into one spinner,
 * and offered no control over the video it subscribed to. Both are covered
 * here, because both are decisions rather than rendering: which connection
 * states are recoverable by the SDK and which need the person to act, and which
 * resolution a menu choice actually asks the SFU for.
 */

import { CallingState } from "@stream-io/video-client";

import { describeCallingState } from "../../lib/stream/connection-state";
import {
  applyIncomingVideoSetting,
  incomingVideoSettingToResolution,
  resolveIncomingVideoSetting,
} from "../../lib/stream/incoming-video";

describe("connection states are told apart", () => {
  it("says nothing at all once the call is joined", () => {
    expect(describeCallingState(CallingState.JOINED)).toBeNull();
  });

  it.each([CallingState.RECONNECTING, CallingState.MIGRATING])(
    "treats %s as transient, with no rejoin action",
    (state) => {
      const advice = describeCallingState(state);
      expect(advice?.tone).toBe("warning");
      expect(advice?.canRejoin).toBe(false);
    },
  );

  it("distinguishes being offline from being reconnected", () => {
    const offline = describeCallingState(CallingState.OFFLINE);
    const reconnecting = describeCallingState(CallingState.RECONNECTING);

    expect(offline?.title).not.toBe(reconnecting?.title);
    // The SDK recovers to RECONNECTING by itself once the network returns, so
    // there is nothing for the person to press.
    expect(offline?.canRejoin).toBe(false);
  });

  it.each([CallingState.RECONNECTING_FAILED, CallingState.LEFT])(
    "offers a manual rejoin from %s, the states a Call instance cannot recover from",
    (state) => {
      const advice = describeCallingState(state);
      expect(advice?.tone).toBe("terminal");
      expect(advice?.canRejoin).toBe(true);
    },
  );

  it("falls back to the ordinary connecting screen for the cold path", () => {
    for (const state of [
      CallingState.IDLE,
      CallingState.JOINING,
      CallingState.RINGING,
      CallingState.UNKNOWN,
    ]) {
      const advice = describeCallingState(state);
      expect(advice?.tone).toBe("loading");
      expect(advice?.canRejoin).toBe(false);
    }
  });
});

describe("incoming video quality maps to what the SFU is asked for", () => {
  it("resolves each named setting to its dimensions", () => {
    expect(incomingVideoSettingToResolution("1080p")).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(incomingVideoSettingToResolution("720p")).toEqual({
      width: 1280,
      height: 720,
    });
    expect(incomingVideoSettingToResolution("480p")).toEqual({
      width: 640,
      height: 480,
    });
    expect(incomingVideoSettingToResolution("auto")).toBeUndefined();
    expect(incomingVideoSettingToResolution("off")).toBeUndefined();
  });

  const makeCall = () => ({
    setIncomingVideoEnabled: jest.fn(),
    setPreferredIncomingVideoResolution: jest.fn(),
  });

  it("turns incoming video off for audio only", () => {
    const call = makeCall();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- only the two setters are exercised
    applyIncomingVideoSetting(call as any, "off");

    expect(call.setIncomingVideoEnabled).toHaveBeenCalledWith(false);
    expect(call.setPreferredIncomingVideoResolution).not.toHaveBeenCalled();
  });

  it("goes back to auto by re-enabling, which drops the cap with it", () => {
    const call = makeCall();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- only the two setters are exercised
    applyIncomingVideoSetting(call as any, "auto");

    // Re-enabling is what undoes both a previous "audio only" and a previous
    // manual cap — the SDK clears the subscription overrides on enable.
    expect(call.setIncomingVideoEnabled).toHaveBeenCalledWith(true);
    expect(call.setPreferredIncomingVideoResolution).not.toHaveBeenCalled();
  });

  it("enables BEFORE capping, so the cap is not wiped by the enable", () => {
    const call = makeCall();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- only the two setters are exercised
    applyIncomingVideoSetting(call as any, "480p");

    expect(call.setIncomingVideoEnabled).toHaveBeenCalledWith(true);
    expect(call.setPreferredIncomingVideoResolution).toHaveBeenCalledWith({
      width: 640,
      height: 480,
    });
    expect(
      call.setIncomingVideoEnabled.mock.invocationCallOrder[0],
    ).toBeLessThan(
      call.setPreferredIncomingVideoResolution.mock.invocationCallOrder[0],
    );
  });

  it("reads the call's own state back into the menu selection", () => {
    expect(resolveIncomingVideoSetting({ enabled: false })).toBe("off");
    expect(resolveIncomingVideoSetting({ enabled: true })).toBe("auto");
    expect(
      resolveIncomingVideoSetting({
        enabled: true,
        preferredResolution: { width: 1280, height: 720 },
      }),
    ).toBe("720p");
    expect(
      resolveIncomingVideoSetting({
        enabled: true,
        preferredResolution: { width: 640, height: 480 },
      }),
    ).toBe("480p");
  });
});
