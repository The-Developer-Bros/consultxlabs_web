"use client";

import { useCall, useCallStateHooks } from "@stream-io/video-react-sdk";
import { Gauge } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  applyIncomingVideoSetting,
  incomingVideoLabels,
  incomingVideoSettings,
  resolveIncomingVideoSetting,
} from "@/lib/stream/incoming-video";
import { cn } from "@/utils/tailwind";

/**
 * Receive-side video quality (#1134).
 *
 * Two jobs at once. It is the escape hatch for "my connection is bad" — the
 * only lever a participant has over their own downlink — and it is the largest
 * single cost control in the video subsystem, because Stream bills the
 * aggregated resolution each participant RECEIVES. See lib/stream/incoming-video.
 *
 * The current value is read from the call rather than mirrored in local state,
 * so it stays honest if anything else changes the subscription.
 */
export function IncomingVideoQualityMenu() {
  const call = useCall();
  const { useIncomingVideoSettings } = useCallStateHooks();
  const { enabled, preferredResolution } = useIncomingVideoSettings();

  const current = resolveIncomingVideoSetting({ enabled, preferredResolution });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="rounded-xl bg-zinc-800 p-3 transition-colors hover:bg-zinc-700"
          title="Video quality"
          aria-label={`Video quality: ${incomingVideoLabels[current].label}`}
        >
          <Gauge className="h-5 w-5 text-white" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="center"
        className="min-w-[240px] rounded-xl border-zinc-800 bg-zinc-900 p-2"
        sideOffset={12}
      >
        <DropdownMenuLabel className="px-3 py-1.5 text-xs font-normal text-zinc-500">
          Video you receive. Lowering it uses less data and steadies a weak
          connection.
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-zinc-800" />
        {incomingVideoSettings.map((setting) => {
          const { label, hint } = incomingVideoLabels[setting];
          return (
            <DropdownMenuItem
              key={setting}
              onClick={() => {
                if (call) applyIncomingVideoSetting(call, setting);
              }}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5",
                current === setting
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-400 hover:bg-zinc-800/50 hover:text-white",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-xs text-zinc-500">{hint}</span>
              </span>
              {current === setting && (
                <span
                  className="h-2 w-2 shrink-0 rounded-full bg-white"
                  aria-hidden="true"
                />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
