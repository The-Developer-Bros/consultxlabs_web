"use client";

/**
 * Proportional revenue-split visualization for collaboration cards.
 * Segments must already sum to ~100; labels are passed as React nodes
 * so callers keep full control of the accurate copy.
 */

import type { ReactNode } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

export type RevenueSplitSegment = {
  key: string;
  percent: number;
  className: string;
};

export function RevenueSplitBar({
  segments,
  label,
  avatar,
}: {
  segments: RevenueSplitSegment[];
  label: ReactNode;
  avatar?: { name: string | null; image: string | null } | null;
}) {
  const visible = segments.filter((s) => s.percent > 0);

  return (
    <div className="rounded-xl border border-zinc-200/80 bg-zinc-50/80 px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        {avatar && (
          <Avatar className="h-6 w-6 ring-2 ring-white shrink-0">
            <AvatarImage src={avatar.image ?? undefined} />
            <AvatarFallback className="text-[9px] bg-zinc-200 text-zinc-700">
              {(avatar.name || "?").charAt(0)}
            </AvatarFallback>
          </Avatar>
        )}
        <div className="min-w-0 flex-1 text-xs text-zinc-600">{label}</div>
      </div>
      {visible.length > 0 && (
        <div
          className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-zinc-200/80"
          role="img"
          aria-label="Revenue split"
        >
          {visible.map((segment) => (
            <div
              key={segment.key}
              className={`h-full ${segment.className}`}
              style={{ width: `${Math.min(100, Math.max(0, segment.percent))}%` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
