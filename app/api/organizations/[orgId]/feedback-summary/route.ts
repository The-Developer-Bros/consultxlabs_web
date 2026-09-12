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
  suppressNarrowerWindow,
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
    excludedFromAggregateAt: null,
  };

  // One read, aggregated in application code, and the ceiling stated out loud.
  //
  // `AppointmentFeedback` carries no consultant column — the consultant is on the
  // slot — and Prisma cannot `groupBy` a relation's scalar, so the per-consultant
  // breakdown has to see rows. Moving only the two WINDOW figures back to
  // `aggregate` + `groupBy(["userId"])` would not help: this findMany still has to
  // run for the breakdown, so peak memory is unchanged, and under `PG_POOL_MAX=1`
  // the four extra statements serialise behind it rather than running alongside.
  //
  // What bounds it is the WHERE: one organisation's own attendee feedback, one row
  // per rated call, and no page of this response is public. The realistic ceiling
  // is members × sessions-per-member, and three ints per row. A denormalised
  // `consultantProfileId` on this table is what would turn the last pass into a
  // `groupBy`, and that is a schema change for the pre-MVP reset — #1550.
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
      respondentIds: raters as ReadonlySet<string>,
      respondents: raters.size,
      responses: subset.length,
      average: subset.length
        ? round1(subset.reduce((sum, r) => sum + r.rating, 0) / subset.length)
        : null,
    };
  };

  const overall = summarise(rows);
  const last30 = summarise(rows.filter((r) => r.createdAt >= since30d));

  // Per consultant. Rows whose slot carries no consultant (a group plan with no
  // named expert) form their own cohort under a sentinel key: never a line in
  // the breakdown, but in the suppression arithmetic, because they are exactly
  // what "total minus the published lines" would otherwise isolate.
  const UNATTRIBUTED = "";
  const byConsultant = new Map<string, typeof rows>();
  for (const row of rows) {
    const id = row.slotOfAppointment?.consultantProfileId ?? UNATTRIBUTED;
    const entry = byConsultant.get(id);
    if (entry) entry.push(row);
    else byConsultant.set(id, [row]);
  }

  // One query for the names, keyed by the ids we actually have. A name is
  // metadata the organisation already sees on its own appointments feed, so it
  // crosses the ADR 20 line the same way a plan title does.
  const namedIds = [...byConsultant.keys()].filter((k) => k !== UNATTRIBUTED);
  const names = namedIds.length
    ? new Map(
        (
          await prisma.consultantProfile.findMany({
            where: { id: { in: namedIds } },
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

  const suppression = applyCohortSuppression(cohorts);
  const published = suppression.published.filter(
    (c) => c.consultantProfileId !== UNATTRIBUTED,
  );
  // Named cohorts only: the unattributed one is not an expert being withheld.
  const consultantsSuppressed =
    suppression.suppressed === 0
      ? 0
      : suppression.hidden.filter((c) => c.consultantProfileId !== UNATTRIBUTED)
          .length;

  /** Below the floor NOTHING is reported — not the average, and not the counts.
   *  ADR 20's stated reason for suppressing is that the count makes the
   *  disclosure trivial, and the previous shape returned `totalResponses` and
   *  `respondents` unconditionally, so at one respondent an organisation learned
   *  that exactly one member had rated exactly one session. */
  const reportable = <
    T extends {
      respondents: number;
      responses: number;
      average: number | null;
    },
  >(
    c: T,
  ) =>
    c.respondents >= ORG_QUALITY_MIN_RESPONDENTS
      ? {
          average: c.average,
          responses: c.responses,
          respondents: c.respondents,
        }
      : { average: null, responses: null, respondents: null };

  /** The 30-day window sits INSIDE the all-time one, so publishing both publishes
   *  the difference — the people who answered longer ago, and their mean, by
   *  subtraction. Six all-time respondents beside five recent ones is one
   *  person's exact rating. Same attack `applyCohortSuppression` handles for the
   *  per-consultant breakdown; it did not cover the two windows. */
  // The people with a response OUTSIDE the window, counted from the rows rather
  // than subtracted: somebody who answered both before and inside it belongs to
  // both cohorts, so a subtraction only lower-bounds this.
  const older = summarise(rows.filter((r) => r.createdAt < since30d));
  const last30Reported = suppressNarrowerWindow(older)
    ? { average: null, responses: null, respondents: null }
    : reportable(last30);

  return NextResponse.json({
    data: {
      // Kept under the old names so the existing card keeps rendering.
      averageRating: reportable(overall).average,
      totalResponses: reportable(overall).responses,
      respondents: reportable(overall).respondents,
      averageRating30d: last30Reported.average,
      responses30d: last30Reported.responses,
      respondents30d: last30Reported.respondents,
      /** The floor itself, so the UI can say "needs 5 responses" rather than
       *  rendering an unexplained blank. */
      minRespondents: ORG_QUALITY_MIN_RESPONDENTS,
      /** Per consultant, already floored and secondarily suppressed. */
      byConsultant: published.map((c) => ({
        consultantProfileId: c.consultantProfileId,
        name: c.name,
        ...reportable(c),
      })),
      /** How many experts are hidden: the difference between "no data on them"
       *  and "not telling you". Stated only when the hidden people themselves
       *  clear the floor; below that it is 0 and nothing is published at all. */
      consultantsSuppressed,
    },
  });
}
