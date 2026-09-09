/**
 * GET /api/organizations/[orgId]/feedback-summary
 *
 * #support-hub — ORG QUALITY SIGNAL over members' private per-appointment
 * CSAT (AppointmentFeedback). Gated on `operations.read`.
 *
 * AGGREGATES ONLY, by design (ADR 20): the rating and the comment are session
 * content — the schema comment "feeds the org-level quality signal" means this
 * endpoint's shape, not a per-member table. No rows leave this endpoint; there
 * is deliberately no drill-down.
 */

import { NextResponse } from "next/server";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { parseRouteParams } from "@/lib/api/support-http";
import { OrgIdParams } from "@/schemas/support";
import prisma from "@/lib/prisma";

const ORG_FEEDBACK_SUMMARY_ROUTE = "organizations.feedback-summary";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  // Parse before authorizing, like the sibling org route. `requireOrgAccess`
  // goes straight to `organization.findUnique`, so an unparsed id answered a
  // malformed value with "organization not found" — an authorization verdict
  // for what is a validation failure.
  const id = await parseRouteParams(OrgIdParams, params, {
    route: ORG_FEEDBACK_SUMMARY_ROUTE,
  });
  if (!id.ok) return id.response;
  const { orgId } = id.data;
  const access = await requireOrgAccess(orgId, {
    permission: "operations.read",
  });
  if (access.error) return access.error;

  const since30d = new Date(Date.now() - 30 * 24 * 3_600_000);

  // #705 — attendee ratings only. The POST authorizes any participant, so a
  // consultant could rate their OWN session into this average. Filtering on
  // CONSULTEE rather than excluding PROVIDER means rows written before the
  // column existed (raterRole NULL, provenance unknown) fail closed instead of
  // being assumed innocent.
  const attendeeRatings = {
    organizationId: orgId,
    raterRole: "CONSULTEE" as const,
  };

  const last30Where = { ...attendeeRatings, createdAt: { gte: since30d } };

  const [overall, last30, overallRaters, last30Raters] = await Promise.all([
    prisma.appointmentFeedback.aggregate({
      where: attendeeRatings,
      _avg: { rating: true },
      _count: { _all: true },
    }),
    prisma.appointmentFeedback.aggregate({
      where: last30Where,
      _avg: { rating: true },
      _count: { _all: true },
    }),
    // DISTINCT RATERS, not rows. #705 moved feedback from one row per booking
    // to one row per CALL, so a row count stopped being a headcount: a single
    // member rating three calls of one subscription (which can hold 24) now
    // clears a three-row threshold on their own, and the "average" handed back
    // is their own private rating. The gate has to count people.
    prisma.appointmentFeedback.groupBy({
      by: ["userId"],
      where: attendeeRatings,
    }),
    prisma.appointmentFeedback.groupBy({
      by: ["userId"],
      where: last30Where,
    }),
  ]);

  // Round to one decimal — an average of 4.333333 renders worse than it reads.
  const round1 = (n: number | null) =>
    n === null ? null : Math.round(n * 10) / 10;

  // Minimum cohort size: below this, the "average" is (part of) one member's
  // exact private rating and the count makes the disclosure trivial — which
  // ADR 20 forbids. Suppress until the aggregate is actually anonymous.
  const MIN_COHORT = 3;

  return NextResponse.json({
    data: {
      averageRating:
        overallRaters.length >= MIN_COHORT ? round1(overall._avg.rating) : null,
      totalResponses: overall._count._all,
      /** How many DISTINCT members the average is drawn from. */
      respondents: overallRaters.length,
      averageRating30d:
        last30Raters.length >= MIN_COHORT ? round1(last30._avg.rating) : null,
      responses30d: last30._count._all,
      respondents30d: last30Raters.length,
    },
  });
}
