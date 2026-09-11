"use client";

import dynamic from "next/dynamic";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { EarningsSummaryPanel } from "./EarningsSummaryPanel";

const AnalyticsPageClient = dynamic(
  () => import("../analytics/AnalyticsPageClient"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        Loading analytics…
      </div>
    ),
  },
);

/**
 * Earnings, with Analytics as its second panel.
 *
 * ADR 19: a navigation entry must be a distinct destination. Analytics was a
 * second sidebar entry over the same object — it called the same
 * `/api/consultant/earnings` endpoint, only adding `?includeMonthly=1` — which
 * is the pattern the rule exists to stop. Both panels keep their own filter and
 * pagination state, deliberately: they answer different questions and resetting
 * one when the other moves would be surprising.
 *
 * Analytics (recharts) is code-split so the Summary tab does not pay for the
 * charting library on first paint.
 */
export function EarningsTabs({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  return (
    <UrlTabs
      tabs={[
        {
          value: "summary",
          label: "Summary",
          content: <EarningsSummaryPanel consultantId={consultantId} />,
        },
        {
          value: "analytics",
          label: "Analytics",
          content: <AnalyticsPageClient consultantId={consultantId} />,
        },
      ]}
    />
  );
}
