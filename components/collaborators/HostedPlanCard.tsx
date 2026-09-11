"use client";

/**
 * Host-perspective card: one of the current consultant's own plans that
 * has collaborators on it.
 */

import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ChevronDown, ChevronUp } from "lucide-react";
import { formatCurrencyAmount } from "@/utils/formatting";
import type { HostedPlanEntry } from "./types";
import { COLLABORATOR_STATUS_BADGE, formatRole } from "./format";
import { RevenueSplitBar } from "./RevenueSplitBar";
import {
  ClassEventList,
  ClassScheduleSummary,
  WebinarEventList,
  WebinarScheduleSummary,
} from "./ScheduleSummaries";

export function HostedPlanCard({
  plan,
  hostUser,
}: {
  plan: HostedPlanEntry;
  hostUser?: { name: string | null; image: string | null };
}) {
  const [eventsExpanded, setEventsExpanded] = useState(false);

  const totalCollabShare = Number(
    (
      plan.collaborators
        .filter((c) => c.status === "PENDING" || c.status === "ACCEPTED")
        .reduce((sum, c) => sum + c.revenueShareBps, 0) / 100
    ).toFixed(2),
  );
  const hostShare = Number((100 - totalCollabShare).toFixed(2));

  const pendingCollabs = plan.collaborators.filter(
    (c) => c.status === "PENDING",
  );
  const acceptedCollabs = plan.collaborators.filter(
    (c) => c.status === "ACCEPTED",
  );

  const hasExpandableDetails =
    (plan.planType === "webinar" &&
      plan.webinarPlan &&
      plan.webinarPlan.webinars.length > 1) ||
    (plan.planType === "class" &&
      plan.classPlan &&
      plan.classPlan.classes.length > 1);

  const planTypeLabel = plan.planType === "webinar" ? "Webinar" : "Class";

  return (
    <Card className="overflow-hidden border-zinc-200/80 shadow-sm transition-shadow hover:shadow-md">
      <div className="p-4 sm:p-5">
        {/* Header — role chip + plan type instead of solid banner */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Badge className="rounded-md border-0 bg-zinc-900 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white hover:bg-zinc-900">
                Host
              </Badge>
              <Badge
                variant="secondary"
                className="rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-[10px] font-medium text-zinc-600"
              >
                {planTypeLabel}
              </Badge>
            </div>
            <p className="truncate text-[15px] font-semibold tracking-tight text-zinc-900">
              {plan.title}
            </p>
            {plan.price > 0 && (
              <p className="mt-0.5 text-sm text-zinc-500">
                {/* `WebinarPlan.price` / `ClassPlan.price` are BigInt paise and
                    the query selects them raw. The major-unit formatter takes
                    rupees, so a ₹500 plan displayed as ₹50,000. */}
                {formatCurrencyAmount(plan.price, "INR")}
              </p>
            )}
          </div>
        </div>

        {/* Revenue split — proportional bar */}
        <div className="mt-3.5">
          <RevenueSplitBar
            avatar={hostUser}
            segments={[
              {
                key: "host",
                percent: hostShare,
                className: "bg-zinc-800",
              },
              {
                key: "collaborators",
                percent: totalCollabShare,
                className: "bg-teal-500/80",
              },
            ]}
            label={
              <>
                <span className="font-semibold text-zinc-800">
                  You {hostShare}%
                </span>
                <span className="text-zinc-400"> · </span>
                <span>Collaborators {totalCollabShare}%</span>
              </>
            }
          />
        </div>

        {/* Collaborators list */}
        <div className="mt-4">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-400">
            Collaborators ({plan.collaborators.length})
          </p>
          <div className="space-y-1.5">
            {[...acceptedCollabs, ...pendingCollabs].map((collab) => (
              <div
                key={collab.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-zinc-100 bg-white px-2.5 py-2"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <Avatar className="h-8 w-8 ring-1 ring-zinc-100">
                    <AvatarImage
                      src={collab.consultantProfile.user.image ?? undefined}
                    />
                    <AvatarFallback className="bg-zinc-100 text-[11px] text-zinc-600">
                      {(collab.consultantProfile.user.name ?? "?").charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-900">
                      {collab.consultantProfile.user.name ?? "Unknown"}
                    </p>
                    <p className="truncate text-xs text-zinc-500">
                      {formatRole(collab.role)} ·{" "}
                      {collab.revenueShareBps / 100}% share
                    </p>
                  </div>
                </div>
                <StatusBadge
                  size="sm"
                  {...COLLABORATOR_STATUS_BADGE[collab.status]}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Schedule summary */}
        <div className="mt-4 rounded-xl border border-zinc-100 bg-zinc-50/50 px-3 py-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-400">
            Schedule
          </p>
          {plan.planType === "webinar" && plan.webinarPlan ? (
            <WebinarScheduleSummary plan={plan.webinarPlan} />
          ) : plan.planType === "class" && plan.classPlan ? (
            <ClassScheduleSummary plan={plan.classPlan} />
          ) : (
            <p className="text-xs italic text-zinc-400">
              No schedule data available
            </p>
          )}

          {hasExpandableDetails && (
            <div className="mt-2.5 border-t border-zinc-100 pt-2.5">
              <button
                type="button"
                onClick={() => setEventsExpanded((prev) => !prev)}
                className="flex items-center gap-1 text-[11px] text-zinc-500 transition-colors hover:text-zinc-800"
              >
                {eventsExpanded ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
                {eventsExpanded ? "Hide" : "Show"} all events
              </button>
              {eventsExpanded && (
                <div className="mt-2">
                  {plan.planType === "webinar" && plan.webinarPlan ? (
                    <WebinarEventList plan={plan.webinarPlan} />
                  ) : plan.planType === "class" && plan.classPlan ? (
                    <ClassEventList plan={plan.classPlan} />
                  ) : null}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
