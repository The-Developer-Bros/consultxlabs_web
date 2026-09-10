/**
 * Org-funded bookings that nobody has scheduled yet — the payer's view.
 *
 * #1166 B2B gap 8. Allocation is a delivery act, so the Requests page is gated
 * on holding a consultant profile. That left the org's OWNER and MAINTAINER —
 * the people who answer for the money — with no surface at all for a request
 * their organization funded and no expert has put slots against. This read
 * backs that view. It returns display facts only: there is nothing to act on
 * here, because choosing a session's times is still the delivering expert's
 * call.
 *
 * Mirrors the allocation tab's own query (`?status=PENDING&orgScope=<orgId>`)
 * so the two surfaces cannot disagree about what "waiting" means, minus the
 * `consultantProfileId` narrowing — the payer sees every expert's queue in
 * their org, which is exactly the blind spot this closes.
 */

import prisma from "@/lib/prisma";
import { AppointmentStatus } from "@prisma/client";
import { scopeToWhereOrgId } from "@/lib/api/scope/parse";

export interface OrgPendingRequest {
  id: string;
  kind: "CONSULTATION" | "SUBSCRIPTION";
  planTitle: string;
  learnerName: string | null;
  expertName: string | null;
  /** ISO — this crosses into a Client Component. */
  requestedAt: string;
}

/** A page of this is a queue, not a ledger; the org home links to the full view. */
const PENDING_TAKE = 50;

export async function readOrgPendingRequests(
  orgId: string,
): Promise<OrgPendingRequest[]> {
  const orgPin = scopeToWhereOrgId({ kind: "org", orgId });
  const planSelect = {
    select: {
      title: true,
      consultantProfile: { select: { user: { select: { name: true } } } },
    },
  } as const;
  const learnerSelect = {
    select: { user: { select: { name: true } } },
  } as const;

  const [consultations, subscriptions] = await Promise.all([
    prisma.consultation.findMany({
      where: {
        status: AppointmentStatus.PENDING,
        appointment: orgPin,
      },
      select: {
        id: true,
        requestedAt: true,
        consultationPlan: planSelect,
        requestedBy: learnerSelect,
      },
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      take: PENDING_TAKE,
    }),
    prisma.subscription.findMany({
      where: {
        status: AppointmentStatus.PENDING,
        appointments: { some: orgPin },
      },
      select: {
        id: true,
        requestedAt: true,
        subscriptionPlan: planSelect,
        requestedBy: learnerSelect,
      },
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      take: PENDING_TAKE,
    }),
  ]);

  return (
    [
      ...consultations.map((c) => ({
        id: c.id,
        kind: "CONSULTATION" as const,
        planTitle: c.consultationPlan.title,
        learnerName: c.requestedBy.user.name,
        expertName: c.consultationPlan.consultantProfile.user.name,
        requestedAt: c.requestedAt.toISOString(),
      })),
      ...subscriptions.map((s) => ({
        id: s.id,
        kind: "SUBSCRIPTION" as const,
        planTitle: s.subscriptionPlan.title,
        learnerName: s.requestedBy.user.name,
        expertName: s.subscriptionPlan.consultantProfile.user.name,
        requestedAt: s.requestedAt.toISOString(),
      })),
    ]
      // Plain string comparison, not localeCompare: ISO-8601 sorts lexically and
      // collation would make the order ICU-dependent.
      .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
      .slice(0, PENDING_TAKE)
  );
}
