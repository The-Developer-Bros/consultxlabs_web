"use client";

import { SfuModels, useCallStateHooks } from "@stream-io/video-react-sdk";
import { SignalLow, VideoOff } from "lucide-react";

/**
 * The two things a participant currently experiences with no explanation
 * (#1134): their own connection degrading, and their neighbour's video going
 * black on its own.
 *
 * `participant.connectionQuality` is the source, NOT `useCallStatsReport()`.
 * The stats report is a two-second polling diagnostic that Stream's own docs
 * warn is CPU-expensive — correct behind the stats button, wrong for a badge
 * that is always mounted. `connectionQuality` is pushed by the SFU on the
 * existing connection and costs nothing.
 *
 * Two rules, both Stream's own guidance, both about not crying wolf:
 * only POOR is surfaced, and only for the LOCAL participant — telling someone
 * their counterpart's link is merely "good" is noise they cannot act on.
 */
export function ConnectionQualityNotice() {
  const { useLocalParticipant, useParticipants } = useCallStateHooks();
  const localParticipant = useLocalParticipant();
  const participants = useParticipants();

  const isPoor =
    localParticipant?.connectionQuality === SfuModels.ConnectionQuality.POOR;

  // Stream's low-bandwidth optimization is ON by default and pauses incoming
  // video under pressure. Nothing in this app said so, so a tile going black
  // read as the other person having turned their camera off — or as a bug.
  const pausedVideo = participants.filter((participant) =>
    participant.pausedTracks?.includes(SfuModels.TrackType.VIDEO),
  );

  if (!isPoor && pausedVideo.length === 0) return null;

  const pausedNames = pausedVideo
    .map((participant) => participant.name || participant.userId)
    .filter(Boolean);

  return (
    <div
      className="pointer-events-none flex flex-col items-start gap-2"
      role="status"
      aria-live="polite"
    >
      {isPoor && (
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 backdrop-blur-sm">
          <SignalLow
            className="h-4 w-4 shrink-0 text-amber-400"
            aria-hidden="true"
          />
          <span className="text-xs font-medium text-amber-200">
            Your connection is weak — try lowering the video quality
          </span>
        </div>
      )}

      {pausedVideo.length > 0 && (
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 backdrop-blur-sm">
          <VideoOff
            className="h-4 w-4 shrink-0 text-zinc-400"
            aria-hidden="true"
          />
          <span className="text-xs text-zinc-300">
            {pausedNames.length === 1
              ? `${pausedNames[0]}'s video is paused to protect the connection`
              : "Some video is paused to protect the connection"}
          </span>
        </div>
      )}
    </div>
  );
}
