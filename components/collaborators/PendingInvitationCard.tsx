"use client";

/**
 * A pending collaboration invitation with Accept / Decline actions.
 * Requires an ancestor <TooltipProvider>.
 */

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AlertTriangle, Check, X } from "lucide-react";
import { formatCurrencyAmount } from "@/utils/formatting";
import type { CollaborationWithPlan } from "./types";
import { ROLE_DESCRIPTIONS, formatRole } from "./format";

export function PendingInvitationCard({
  collab,
  onRespond,
  isResponding,
}: {
  collab: CollaborationWithPlan;
  onRespond: (args: {
    id: string;
    planType: "webinar" | "class";
    response: "ACCEPTED" | "DECLINED";
  }) => void;
  isResponding: boolean;
}) {
  const inviter = collab.invitedBy.user;
  const planTypeLabel = collab.planType === "webinar" ? "Webinar" : "Class";

  return (
    <Card className="overflow-hidden border-amber-200/80 bg-gradient-to-br from-amber-50/90 to-white shadow-sm">
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <Badge className="rounded-md border-0 bg-amber-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white hover:bg-amber-600">
              Invitation
            </Badge>
            <Badge
              variant="secondary"
              className="rounded-md border border-amber-200/80 bg-white px-2 py-0.5 text-[10px] font-medium text-zinc-600"
            >
              {planTypeLabel}
            </Badge>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className="cursor-help rounded-md border-amber-200 bg-white px-2 py-0.5 text-[10px] text-zinc-700"
                >
                  {formatRole(collab.role)}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  {ROLE_DESCRIPTIONS[collab.role] ?? formatRole(collab.role)}
                </p>
              </TooltipContent>
            </Tooltip>
          </div>

          <p className="text-[15px] font-semibold tracking-tight text-zinc-900">
            {collab.planTitle}
          </p>

          <div className="mt-2 flex items-center gap-2">
            <Avatar className="h-6 w-6 ring-1 ring-amber-100">
              <AvatarFallback className="bg-amber-100 text-[9px] text-amber-900">
                {(inviter.name ?? "?").charAt(0)}
              </AvatarFallback>
            </Avatar>
            <p className="text-sm text-zinc-600">
              Invited by{" "}
              <span className="font-medium text-zinc-800">
                {inviter.name ?? "Unknown"}
              </span>
            </p>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
            <span className="font-medium text-zinc-700">
              {collab.revenueShareBps / 100}% revenue share
            </span>
            {collab.planPrice > 0 && (
              <>
                <span className="text-zinc-300">·</span>
                <span>
                  Plan price{" "}
                  {/* Paise: `planPrice` is copied straight off
                      WebinarPlan/ClassPlan.price. Shown to a collaborator who
                      is deciding on a revenue share, so a 100x error here is
                      not cosmetic. */}
                  {formatCurrencyAmount(collab.planPrice, "INR")}
                </span>
              </>
            )}
          </div>

          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200/70 bg-amber-50/80 px-2.5 py-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              You won&apos;t earn from purchases made before you accept the
              collaborations request.
            </span>
          </div>
        </div>

        <div className="flex shrink-0 gap-2 sm:flex-col sm:items-stretch">
          <Button
            size="sm"
            variant="default"
            className="flex-1 sm:flex-none"
            onClick={() =>
              onRespond({
                id: collab.id,
                planType: collab.planType,
                response: "ACCEPTED",
              })
            }
            disabled={isResponding}
          >
            <Check className="mr-1 h-3.5 w-3.5" />
            Accept
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1 border-zinc-200 bg-white sm:flex-none"
            onClick={() =>
              onRespond({
                id: collab.id,
                planType: collab.planType,
                response: "DECLINED",
              })
            }
            disabled={isResponding}
          >
            <X className="mr-1 h-3.5 w-3.5" />
            Decline
          </Button>
        </div>
      </div>
    </Card>
  );
}
