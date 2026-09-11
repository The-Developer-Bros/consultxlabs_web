"use client";

/**
 * The one Support surface, shared by the consultant and consultee dashboards.
 *
 * Before this, the two roles had asymmetric and incomplete halves of the same
 * idea: consultees got `/feedback` (labelled "Support" in the nav, with a
 * hand-rolled two-button switcher) and no help content at all; consultants got
 * a static FAQ at `/help` reachable only from the avatar dropdown, and no way
 * to raise a ticket or leave feedback from their dashboard.
 *
 * Both now get the same three tabs in the same nav position. The panels are
 * role-agnostic because the endpoints behind them are: `/api/user/feedbacks`
 * and `/api/user/support-tickets` both key off `session.user.id`, not off a
 * consultee profile.
 *
 * #support-hub: the body is now the Swiggy-style hub (Sessions / Platform
 * subtabs). The org-workspace tree mounts this surface too — the hub is
 * role-agnostic by construction, and operator flows (org billing intents,
 * org attribution on escalation) activate server-side from memberships, so
 * no prop threading is needed here.
 */

import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";

import { SupportHub } from "./SupportHub";

export function SupportSurface({ profileId }: { profileId: string }) {
  return (
    <DashboardErrorBoundary>
      <DashboardHeader
        title="Support"
        subtitle="Get help with a session or the platform, and track every request."
      />
      <SupportHub profileId={profileId} />
    </DashboardErrorBoundary>
  );
}
