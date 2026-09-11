"use client";

/**
 * "Needs you now" — the block that answers *what do I do next*.
 *
 * Extracted from the org dashboard's ActionCenter, which was the only home
 * page that led with what needed attention. The consultant and consultee
 * homes led with previews of other tabs instead: consultant home rendered
 * Today's Appointments, Upcoming Sessions and Pending Requests as three full
 * card sections, each a smaller copy of the tab it linked to, and consultee
 * home paired an upcoming-sessions rail with a 429-line pending-payments
 * widget. A user scanning either one had to read a summary of the whole
 * product to find the one thing that was actually waiting on them.
 *
 * Renders nothing when there is nothing to do, so a clear queue costs no
 * vertical space — the page falls straight through to its content.
 */

import Link from "next/link";
import { AlertCircle, AlertTriangle, ArrowRight, Info } from "lucide-react";

import type { ActionItem } from "@/lib/enterprise/org-activation";

const ACTION_TONE = {
  critical: {
    card: "border-rose-200 bg-rose-50 dark:border-rose-900/50 dark:bg-rose-950/30",
    icon: AlertCircle,
    iconColor: "text-rose-600 dark:text-rose-400",
  },
  warning: {
    card: "border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30",
    icon: AlertTriangle,
    iconColor: "text-amber-600 dark:text-amber-400",
  },
  info: {
    card: "border-sky-200 bg-sky-50 dark:border-sky-900/50 dark:bg-sky-950/30",
    icon: Info,
    iconColor: "text-sky-600 dark:text-sky-400",
  },
} as const;

export function ActionRequiredPanel({
  items,
  heading = "Needs you now",
  className,
}: {
  items: ActionItem[];
  heading?: string;
  className?: string;
}) {
  if (items.length === 0) return null;

  return (
    <div className={className ?? "mb-6 space-y-2"}>
      <h2 className="text-sm font-semibold text-foreground">{heading}</h2>
      {items.map((item) => {
        const tone = ACTION_TONE[item.severity];
        const Icon = tone.icon;
        return (
          <Link key={item.key} href={item.ctaHref} className="block">
            <div
              className={`flex items-start gap-3 rounded-lg border p-3 transition-colors hover:brightness-[0.98] ${tone.card}`}
            >
              <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${tone.iconColor}`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">
                  {item.title}
                </p>
                <p className="text-sm text-muted-foreground">{item.body}</p>
              </div>
              <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-foreground">
                {item.ctaLabel}
                <ArrowRight className="h-4 w-4" />
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
