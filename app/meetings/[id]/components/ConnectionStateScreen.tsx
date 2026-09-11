"use client";

import { Loader2, RefreshCw, SignalLow, WifiOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/utils/tailwind";
import {
  type ConnectionAdvice,
  type ConnectionTone,
} from "@/lib/stream/connection-state";

const TONE_STYLES: Record<
  ConnectionTone,
  { ring: string; glow: string; icon: string }
> = {
  loading: {
    ring: "border-zinc-700 bg-zinc-800",
    glow: "bg-white/10",
    icon: "text-white",
  },
  warning: {
    ring: "border-amber-500/30 bg-amber-500/10",
    glow: "bg-amber-500/20",
    icon: "text-amber-400",
  },
  terminal: {
    ring: "border-red-500/30 bg-red-500/10",
    glow: "bg-red-500/20",
    icon: "text-red-400",
  },
};

/**
 * The screen shown whenever the call is not connected (#1134).
 *
 * One layout, four meanings — the copy and the action come from
 * `describeCallingState`, so the state machine lives in one testable place and
 * this file only decides what it looks like.
 */
export function ConnectionStateScreen({
  advice,
  isOffline,
  onRejoin,
  onLeave,
}: {
  advice: ConnectionAdvice;
  isOffline: boolean;
  onRejoin: () => void;
  onLeave: () => void;
}) {
  const tone = TONE_STYLES[advice.tone];
  const Icon = isOffline ? WifiOff : advice.canRejoin ? SignalLow : Loader2;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950 px-4">
      <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiNmZmYiIGZpbGwtb3BhY2l0eT0iMC4wMiI+PGNpcmNsZSBjeD0iMzAiIGN5PSIzMCIgcj0iMiIvPjwvZz48L2c+PC9zdmc+')] opacity-50" />

      <div
        className="relative z-10 flex max-w-md flex-col items-center text-center"
        role="status"
        aria-live="polite"
      >
        <div className="relative mb-6">
          <div
            className={cn("absolute inset-0 rounded-full blur-xl", tone.glow)}
          />
          <div
            className={cn(
              "relative flex h-20 w-20 items-center justify-center rounded-2xl border",
              tone.ring,
            )}
          >
            <Icon
              className={cn(
                "h-8 w-8",
                tone.icon,
                // Only the states the SDK is still working on get motion. A
                // spinner on a terminal state is the exact lie this replaces.
                advice.tone !== "terminal" && !isOffline && "animate-spin",
              )}
              aria-hidden="true"
            />
          </div>
        </div>

        <p className="mb-2 text-lg font-medium text-white">{advice.title}</p>
        <p className="text-sm text-zinc-400">{advice.description}</p>

        {/* Leave renders for EVERY state this screen covers, Rejoin only for the
            terminal ones. Gating both on `canRejoin` left someone in
            RECONNECTING, MIGRATING or OFFLINE on a full-screen takeover with no
            control at all — waiting on a reconnection that may never come, with
            the browser back button as the only exit. A screen that occupies the
            whole viewport has to offer a way off it. */}
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          {advice.canRejoin && (
            <Button
              onClick={onRejoin}
              className="h-auto bg-primary px-6 py-2.5 text-primary-foreground hover:bg-primary/90"
            >
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              Rejoin session
            </Button>
          )}
          <Button
            onClick={onLeave}
            variant="outline"
            className="h-auto border-zinc-700 bg-transparent px-6 py-2.5 text-white hover:border-zinc-600 hover:bg-zinc-800"
          >
            Leave
          </Button>
        </div>
      </div>
    </div>
  );
}
