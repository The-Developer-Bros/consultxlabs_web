"use client";

/**
 * Collaborator-perspective card: a plan the current consultant was invited
 * onto and has accepted. Requires an ancestor <TooltipProvider>.
 */

import { useState } from "react";
import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { CollaborationWithPlan } from "./types";
import {
  COLLABORATOR_STATUS_BADGE,
  ROLE_DESCRIPTIONS,
  formatRole,
} from "./format";
import { RevenueSplitBar } from "./RevenueSplitBar";
import {
  ClassEventList,
  ClassScheduleSummary,
  WebinarEventList,
  WebinarScheduleSummary,
} from "./ScheduleSummaries";

export function ActiveCollaborationCard({
  collab,
  currentUser,
}: {
  collab: CollaborationWithPlan;
  currentUser?: { name: string | null; image: string | null };
}) {
  const [slotsExpanded, setSlotsExpanded] = useState(false);

  const owner =
    collab.planType === "webinar"
      ? collab.webinarPlan?.consultantProfile
      : collab.classPlan?.consultantProfile;

  const allCollaboratorsOnPlan =
    (collab.planType === "webinar"
      ? collab.webinarPlan?.collaborators
      : collab.classPlan?.collaborators) ?? [];
  const otherCollaborators = allCollaboratorsOnPlan.filter(
    (c) => c.id !== collab.id,
  );

  // Accurate shares: host = remainder after PENDING+ACCEPTED collaborators
  const countedCollaborators = allCollaboratorsOnPlan.filter(
    (c) => c.status === "PENDING" || c.status === "ACCEPTED",
  );
  const totalCollabShare =
    countedCollaborators.reduce((sum, c) => sum + c.revenueShareBps, 0) / 100;
  const hostShare = Number((100 - totalCollabShare).toFixed(2));
  const youShare = Number((collab.revenueShareBps / 100).toFixed(2));
  const otherShare = Number(
    Math.max(0, totalCollabShare - youShare).toFixed(2),
  );

  const hasExpandableDetails =
    (collab.planType === "webinar" &&
      collab.webinarPlan &&
      collab.webinarPlan.webinars.length > 1) ||
    (collab.planType === "class" &&
      collab.classPlan &&
      collab.classPlan.classes.length > 1);

  const planTypeLabel = collab.planType === "webinar" ? "Webinar" : "Class";
  const roleLabel = formatRole(collab.role);

  return (
    <Card className="overflow-hidden border-zinc-200/80 shadow-sm transition-shadow hover:shadow-md">
      <div className="p-4 sm:p-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge className="cursor-help rounded-md border-0 bg-teal-700 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white hover:bg-teal-700">
                    {roleLabel}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p>
                    {ROLE_DESCRIPTIONS[collab.role] ?? formatRole(collab.role)}
                  </p>
                </TooltipContent>
              </Tooltip>
              <Badge
                variant="secondary"
                className="rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-[10px] font-medium text-zinc-600"
              >
                {planTypeLabel}
              </Badge>
            </div>
            {owner?.id ? (
              <Link
                href={`/dashboard/consultant/${owner.id}/planner`}
                className="block truncate text-[15px] font-semibold tracking-tight text-zinc-900 hover:underline"
              >
                {collab.planTitle}
              </Link>
            ) : (
              <p className="truncate text-[15px] font-semibold tracking-tight text-zinc-900">
                {collab.planTitle}
              </p>
            )}
            <p className="mt-0.5 text-sm text-zinc-500">
              by {owner?.user.name ?? "Unknown"}
            </p>
          </div>
        </div>

        {/* Revenue share — accurate host remainder, not 100 − you alone */}
        <div className="mt-3.5">
          <RevenueSplitBar
            avatar={currentUser}
            segments={[
              {
                key: "you",
                percent: youShare,
                className: "bg-teal-600",
              },
              {
                key: "host",
                percent: hostShare,
                className: "bg-zinc-800",
              },
              {
                key: "others",
                percent: otherShare,
                className: "bg-zinc-300",
              },
            ]}
            label={
              <>
                <span className="font-semibold text-zinc-800">
                  You {youShare}%
                </span>
                {owner && (
                  <>
                    <span className="text-zinc-400"> · </span>
                    <span>
                      {owner.user.name} {hostShare}%
                    </span>
                  </>
                )}
                {otherShare > 0 && (
                  <>
                    <span className="text-zinc-400"> · </span>
                    <span>Others {otherShare}%</span>
                  </>
                )}
              </>
            }
          />
        </div>

        {/* Team — host + other collaborators (self is in the header/share) */}
        <div className="mt-4">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-400">
            Team ({(owner ? 1 : 0) + otherCollaborators.length})
          </p>
          <div className="space-y-1.5">
            {owner && (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-100 bg-white px-2.5 py-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Avatar className="h-8 w-8 ring-1 ring-zinc-100">
                    <AvatarImage src={owner.user.image ?? undefined} />
                    <AvatarFallback className="bg-zinc-100 text-[11px] text-zinc-600">
                      {(owner.user.name ?? "H").charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-900">
                      {owner.user.name ?? "Unknown"}
                    </p>
                    <p className="truncate text-xs text-zinc-500">
                      Host · {hostShare}% share
                    </p>
                  </div>
                </div>
                <Badge
                  variant="default"
                  className="border-zinc-200 bg-zinc-100 text-[10px] text-zinc-700"
                >
                  Owner
                </Badge>
              </div>
            )}
            {otherCollaborators.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-zinc-100 bg-white px-2.5 py-2"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <Avatar className="h-8 w-8 ring-1 ring-zinc-100">
                    <AvatarImage
                      src={c.consultantProfile.user.image ?? undefined}
                    />
                    <AvatarFallback className="bg-zinc-100 text-[11px] text-zinc-600">
                      {(c.consultantProfile.user.name ?? "?").charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-900">
                      {c.consultantProfile.user.name ?? "Unknown"}
                    </p>
                    <p className="truncate text-xs text-zinc-500">
                      {formatRole(c.role)} · {c.revenueShareBps / 100}% share
                    </p>
                  </div>
                </div>
                <StatusBadge
                  size="sm"
                  {...COLLABORATOR_STATUS_BADGE[c.status]}
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
          {collab.planType === "webinar" && collab.webinarPlan ? (
            <WebinarScheduleSummary plan={collab.webinarPlan} />
          ) : collab.planType === "class" && collab.classPlan ? (
            <ClassScheduleSummary plan={collab.classPlan} />
          ) : (
            <p className="text-xs italic text-zinc-400">
              No schedule data available
            </p>
          )}

          {hasExpandableDetails && (
            <div className="mt-2.5 border-t border-zinc-100 pt-2.5">
              <button
                type="button"
                onClick={() => setSlotsExpanded((prev) => !prev)}
                className="flex items-center gap-1 text-[11px] text-zinc-500 transition-colors hover:text-zinc-800"
              >
                {slotsExpanded ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
                {slotsExpanded ? "Hide" : "Show"} all events
              </button>
              {slotsExpanded && (
                <div className="mt-2">
                  {collab.planType === "webinar" && collab.webinarPlan ? (
                    <WebinarEventList plan={collab.webinarPlan} />
                  ) : collab.planType === "class" && collab.classPlan ? (
                    <ClassEventList plan={collab.classPlan} />
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
