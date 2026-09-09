/**
 * GET /api/organizations/[orgId]/feedback-summary
 *
 * #1300 — ORG QUALITY SIGNAL over members' private per-call CSAT
 * (`AppointmentFeedback`). Gated on `quality.read`.
 *
 * AGGREGATES ONLY, by design (ADR 20): the rating and the comment are session
 * content. No rows leave this endpoint and there is deliberately no drill-down to
 * a named member.
 *
 * It now answers the question an enterprise buyer actually has — *which of our
 * experts is worth re-booking* — with a PER-CONSULTANT breakdown rather than one
 * org-wide number. That is still aggregate and still metadata under ADR 20, and it
 * is the same line BetterUp's employer dashboard draws. What makes it safe is the
 * cohort floor and the secondary suppression in `lib/enterprise/quality-thresholds`:
 * a breakdown published beside a total is exactly where subtraction re-identifies
 * somebody, so we never hide exactly one cohort.
 */

import { NextResponse } from "next/server";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { parseRouteParams } from "@/lib/api/support-http";
import { OrgIdParams } from "@/schemas/support";
import prisma from "@/lib/prisma";
import {
  ORG_QUALITY_MIN_RESPONDENTS,
  applyCohortSuppression,
} from "@/lib/enterprise/quality-thresholds";

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
    permission: "quality.read",
  });
  if (access.error) return access.error;

  const since30d = new Date(Date.now() - 30 * 24 * 3_600_000);

  // #705 — attendee ratings only. The POST authorizes any participant, so a
  // consultant could rate their OWN session into this average. Filtering on
  // CONSULTEE rather than excluding PROVIDER means rows written before the
  // column existed (raterRole NULL, provenance unknown) fail closed instead of
  // being assumed innocent.
  //
  // #1300 — and only rows that still count: a moderated-away comment's rating
  // goes with it, and a rating we adjudicated as caused by our own outage must
  // not read to an organisation as a bad consultant either.
  const attendeeRatings = {
    organizationId: orgId,
    raterRole: "CONSULTEE" as const,
    deletedAt: null,
    excludedFromAggregateAt: null,
  };

  // One read, aggregated in application code. `AppointmentFeedback` carries no
  // consultant column — the consultant is on the slot — and Prisma cannot
  // `groupBy` a relation's scalar, so the alternative is a raw query. An
  // organisation's own feedback is small enough that this is the cheaper honest
  // option, and it keeps one filter definition instead of two.
  const rows = await prisma.appointmentFeedback.findMany({
    where: attendeeRatings,
    select: {
      userId: true,
      rating: true,
      createdAt: true,
      // `SlotOfAppointment.consultantProfileId` is a denormalised bare string
      // with no relation — it exists to feed the btree_gist overlap constraint —
      // so the name is resolved in one follow-up query below rather than joined.
      slotOfAppointment: { select: { consultantProfileId: true } },
    },
  });

  const round1 = (n: number) => Math.round(n * 10) / 10;

  /** Respondents are PEOPLE, never rows. Feedback is one row per CALL, so a single
   *  member rating three sessions of one subscription would clear a row-counted
   *  floor alone — and the "average" handed back would be their own rating. */
  const summarise = (subset: typeof rows) => {
    const raters = new Set(subset.map((r) => r.userId));
    return {
      respondents: raters.size,
      responses: subset.length,
      average: subset.length
        ? round1(subset.reduce((sum, r) => sum + r.rating, 0) / subset.length)
        : null,
    };
  };

  const overall = summarise(rows);
  const last30 = summarise(rows.filter((r) => r.createdAt >= since30d));

  // Per consultant. A row whose slot carries no consultant cannot be attributed
  // to one, so it counts toward the org total and toward nobody's breakdown.
  const byConsultant = new Map<string, typeof rows>();
  for (const row of rows) {
    const id = row.slotOfAppointment?.consultantProfileId;
    if (!id) continue;
    const entry = byConsultant.get(id);
    if (entry) entry.push(row);
    else byConsultant.set(id, [row]);
  }

  // One query for the names, keyed by the ids we actually have. A name is
  // metadata the organisation already sees on its own appointments feed, so it
  // crosses the ADR 20 line the same way a plan title does.
  const names = byConsultant.size
    ? new Map(
        (
          await prisma.consultantProfile.findMany({
            where: { id: { in: [...byConsultant.keys()] } },
            select: { id: true, user: { select: { name: true } } },
          })
        ).map((c) => [c.id, c.user?.name ?? null]),
      )
    : new Map<string, string | null>();

  const cohorts = [...byConsultant.entries()]
    .map(([consultantProfileId, cohortRows]) => ({
      consultantProfileId,
      name: names.get(consultantProfileId) ?? null,
      ...summarise(cohortRows),
    }))
    .sort((a, b) => b.respondents - a.respondents);

  const { published, suppressed } = applyCohortSuppression(cohorts);

  /** Below the floor NOTHING is reported — not the average, and not the counts.
   *  ADR 20's stated reason for suppressing is that the count makes the
   *  disclosure trivial, and the previous shape returned `totalResponses` and
   *  `respondents` unconditionally, so at one respondent an organisation learned
   *  that exactly one member had rated exactly one session. */
  const reportable = <T extends { respondents: number; responses: number; average: number | null }>(
    c: T,
  ) =>
    c.respondents >= ORG_QUALITY_MIN_RESPONDENTS
      ? { average: c.average, responses: c.responses, respondents: c.respondents }
      : { average: null, responses: null, respondents: null };

  return NextResponse.json({
    data: {
      // Kept under the old names so the existing card keeps rendering.
      averageRating: reportable(overall).average,
      totalResponses: reportable(overall).responses,
      respondents: reportable(overall).respondents,
      averageRating30d: reportable(last30).average,
      responses30d: reportable(last30).responses,
      respondents30d: reportable(last30).respondents,
      /** The floor itself, so the UI can say "needs 5 responses" rather than
       *  rendering an unexplained blank. */
      minRespondents: ORG_QUALITY_MIN_RESPONDENTS,
      /** Per consultant, already floored and secondarily suppressed. */
      byConsultant: published.map((c) => ({
        consultantProfileId: c.consultantProfileId,
        name: c.name,
        ...reportable(c),
      })),
      /** How many experts are hidden. A count of hidden cohorts is safe to state
       *  and is the difference between "we have no data on them" and "we are not
       *  telling you" — never one, by construction. */
      consultantsSuppressed: suppressed,
    },
  });
}
