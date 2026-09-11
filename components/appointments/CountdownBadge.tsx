"use client";

import { useEffect, useState } from "react";
import { cn } from "@/utils/tailwind";

interface CountdownBadgeProps {
  targetDate: Date | string;
  sessionEndDate?: Date | string;
}

type Tier = "far" | "soon" | "imminent" | "now" | "live" | "ended";

function getTier(diffMs: number, isOngoing: boolean): Tier {
  if (isOngoing) return "live";
  if (diffMs <= 0) return "now";
  const minutes = diffMs / 60000;
  if (minutes <= 10) return "now";
  if (minutes <= 30) return "imminent";
  if (minutes <= 180) return "soon";
  return "far";
}

function formatCountdown(diffMs: number): string {
  if (diffMs <= 0) return "NOW";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

const tierStyles: Record<Tier, string> = {
  far: "bg-muted text-muted-foreground",
  soon: "bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-300",
  imminent:
    "bg-orange-50 text-orange-600 dark:bg-orange-900/30 dark:text-orange-300",
  now: "bg-green-50 text-green-600 animate-pulse dark:bg-green-900/30 dark:text-green-300",
  live: "bg-red-50 text-red-600 animate-pulse dark:bg-red-900/30 dark:text-red-300",
  ended: "bg-muted text-muted-foreground/70",
};

export function CountdownBadge({
  targetDate,
  sessionEndDate,
}: CountdownBadgeProps) {
  const [now, setNow] = useState(() => Date.now());

  const target = new Date(targetDate).getTime();
  const end = sessionEndDate ? new Date(sessionEndDate).getTime() : null;
  const diffMs = target - now;
  const isOngoing = diffMs <= 0 && end !== null && now <= end;
  const isEnded = end !== null && now > end;

  useEffect(() => {
    if (isEnded) return;

    // Compute interval inside effect — only re-run when targetTime or isEnded change
    const getInterval = () => {
      const minutes = Math.abs(target - Date.now()) / 60000;
      if (minutes <= 1) return 1000; // every second when very close
      if (minutes <= 30) return 10000; // every 10s when imminent
      if (minutes <= 180) return 60000; // every minute when soon
      return 300000; // every 5 minutes when far
    };

    const id = setInterval(() => setNow(Date.now()), getInterval());
    return () => clearInterval(id);
  }, [target, isEnded]);

  if (isEnded) return null;

  const tier = getTier(diffMs, isOngoing);
  const label = isOngoing ? "LIVE" : formatCountdown(diffMs);

  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold tabular-nums",
        tierStyles[tier],
      )}
      aria-label={isOngoing ? "Live session" : `Session starts in ${label}`}
    >
      {label}
    </span>
  );
}
