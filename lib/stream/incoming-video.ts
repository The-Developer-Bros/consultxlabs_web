import { type Call, SfuModels } from "@stream-io/video-react-sdk";

/**
 * Incoming video quality, as a user-facing choice (#1134).
 *
 * This is a cost lever before it is a UX one. Stream bills video by the
 * AGGREGATED RECEIVED resolution per 1,000 participant-minutes, so what each
 * participant subscribes to is what we pay for:
 *
 *   1080p  $3.00      720p  $1.50      480p  $0.75      audio only  $0.30
 *
 * A consultation held at "HD" costs 2x the same consultation at "SD" and 10x
 * one held with video off, for a picture nobody asked for on a laptop-sized
 * tile. It is also the honest answer to "my connection is bad": dropping the
 * resolution you RECEIVE is the one thing a participant can do about their own
 * downlink, and until now the app offered nothing.
 */
export const incomingVideoSettings = [
  "auto",
  "1080p",
  "720p",
  "480p",
  "off",
] as const;

export type IncomingVideoSetting = (typeof incomingVideoSettings)[number];

const RESOLUTIONS: Record<
  Exclude<IncomingVideoSetting, "auto" | "off">,
  SfuModels.VideoDimension
> = {
  "1080p": { width: 1920, height: 1080 },
  "720p": { width: 1280, height: 720 },
  "480p": { width: 640, height: 480 },
};

/** Labels are in the viewer's terms, not the encoder's. */
export const incomingVideoLabels: Record<
  IncomingVideoSetting,
  { label: string; hint: string }
> = {
  auto: { label: "Auto", hint: "Matches your connection" },
  "1080p": { label: "Full HD", hint: "Sharpest — uses the most data" },
  "720p": { label: "HD", hint: "Good detail, moderate data" },
  "480p": { label: "SD", hint: "Steadier on a weak connection" },
  off: { label: "Audio only", hint: "Uses the least data" },
};

export function incomingVideoSettingToResolution(
  setting: IncomingVideoSetting,
): SfuModels.VideoDimension | undefined {
  if (setting === "auto" || setting === "off") return undefined;
  return RESOLUTIONS[setting];
}

/**
 * Applies the choice to the call.
 *
 * `auto` and `off` are the two ends of `setIncomingVideoEnabled` — enabling
 * also drops any resolution preference, which is what makes it the way back
 * from a manual cap as well as from audio-only.
 *
 * Order matters for the capped settings: enabling clears the overrides, so the
 * resolution has to be set AFTER it or it is wiped by the same call that was
 * meant to make room for it.
 */
export function applyIncomingVideoSetting(
  call: Call,
  setting: IncomingVideoSetting,
): void {
  if (setting === "off") {
    call.setIncomingVideoEnabled(false);
    return;
  }

  call.setIncomingVideoEnabled(true);

  if (setting !== "auto") {
    call.setPreferredIncomingVideoResolution(
      incomingVideoSettingToResolution(setting),
    );
  }
}

/**
 * Reads `useIncomingVideoSettings()` back into the choice that produced it, so
 * the menu shows what is actually in force rather than a local mirror that can
 * drift from the call.
 */
export function resolveIncomingVideoSetting(state: {
  enabled: boolean;
  preferredResolution?: SfuModels.VideoDimension;
}): IncomingVideoSetting {
  if (!state.enabled) return "off";
  const height = state.preferredResolution?.height;
  if (!height) return "auto";
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  return "480p";
}
