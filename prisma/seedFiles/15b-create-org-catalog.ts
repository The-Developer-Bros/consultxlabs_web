import prisma from "../../lib/prisma";
import {
  CLASS_CURRICULUM,
  CLASS_DESCRIPTIONS,
  FAQ_POOL,
  PLAN_SUBTITLES,
  TARGET_AUDIENCE_POOL,
  WEBINAR_DESCRIPTIONS,
  WHATS_INCLUDED_POOL,
  pick,
} from "./plan-content";

/**
 * Org-OWNED catalog plans — the paths #1050 and #1053 shipped without coverage.
 *
 * Nothing in the seed suite ever set `organizationId`, `visibility` or
 * `archivedAt` on a plan, so a local database could not exercise any of:
 *   - the org catalog page at /dashboard/organization/[orgId]/catalog,
 *   - the ORG_ONLY marketplace leak guard (#726),
 *   - the archive/restore flow and the discovery gate that respects it,
 *   - the member-facing catalog panel that makes ORG_ONLY reachable at all.
 *
 * One plan per visibility value plus one archived plan gives every branch a
 * row. Only canHost orgs get a catalog: a sponsor-only org selling its own
 * offerings is not a state the product allows.
 */
export async function createOrgCatalog() {
  console.log("Creating org-owned catalog plans...");

  const hostOrgs = await prisma.organization.findMany({
    where: { canHost: true, status: "ACTIVE", deletedAt: null },
    select: {
      id: true,
      name: true,
      memberships: {
        where: {
          role: "EXPERT",
          status: "ACTIVE",
          consultantProfileId: { not: null },
        },
        select: { consultantProfileId: true },
        take: 1,
      },
    },
    take: 3,
  });

  if (hostOrgs.length === 0) {
    console.warn("No canHost orgs with an ACTIVE EXPERT — skipping catalog.");
    return;
  }

  let created = 0;
  for (const [orgIndex, org] of hostOrgs.entries()) {
    const consultantProfileId = org.memberships[0]?.consultantProfileId;
    if (!consultantProfileId) {
      console.warn(`Org ${org.name} has no expert to deliver — skipping.`);
      continue;
    }

    const common = {
      organizationId: org.id,
      consultantProfileId,
      priceCurrency: "INR" as const,
      language: "English",
      targetAudience: pick(TARGET_AUDIENCE_POOL, orgIndex),
      whatsIncluded: pick(WHATS_INCLUDED_POOL, orgIndex),
      faqs: {
        create: pick(FAQ_POOL, orgIndex).map((faq, order) => ({
          ...faq,
          order,
        })),
      },
    };

    // PUBLIC + ORG_AND_PUBLIC are discoverable; ORG_ONLY must never reach
    // /explore/** and is only visible on the member catalog panel.
    const webinarVisibilities = [
      "ORG_AND_PUBLIC",
      "ORG_ONLY",
      "PUBLIC",
    ] as const;

    for (const [i, visibility] of webinarVisibilities.entries()) {
      await prisma.webinarPlan.create({
        data: {
          ...common,
          visibility,
          title: `${org.name} — ${visibility === "ORG_ONLY" ? "Internal" : "Open"} Masterclass ${i + 1}`,
          subtitle: pick(PLAN_SUBTITLES, orgIndex + i),
          description: pick(WEBINAR_DESCRIPTIONS, orgIndex + i),
          price: 150000 + i * 50000,
          durationInHours: 1.5,
          maxParticipants: 100,
          certificateProvided: i === 0,
        },
      });
      created += 1;
    }

    await prisma.classPlan.create({
      data: {
        ...common,
        visibility: "ORG_AND_PUBLIC",
        title: `${org.name} — Cohort Programme`,
        subtitle: pick(PLAN_SUBTITLES, orgIndex + 3),
        description: pick(CLASS_DESCRIPTIONS, orgIndex),
        price: 2500000,
        durationInMonths: 2,
        sessionsPerWeek: 2,
        sessionDurationInHours: 1.5,
        totalSessions: 16,
        totalHours: 24,
        maxParticipants: 20,
        certificateProvided: true,
        classContents: {
          create: CLASS_CURRICULUM.map((item, index) => ({
            ...item,
            order: index + 1,
            hoursAllotted: 1.5,
          })),
        },
      },
    });
    created += 1;

    // An archived plan, so the archive tab, the restore path and the
    // discovery gate that must exclude it all have something to act on.
    await prisma.classPlan.create({
      data: {
        ...common,
        visibility: "ORG_AND_PUBLIC",
        title: `${org.name} — Retired Bootcamp`,
        subtitle: "No longer offered — kept for past enrolments",
        description: pick(CLASS_DESCRIPTIONS, orgIndex + 1),
        price: 1800000,
        durationInMonths: 1,
        sessionsPerWeek: 1,
        sessionDurationInHours: 1,
        totalSessions: 4,
        totalHours: 4,
        maxParticipants: 15,
        archivedAt: new Date(),
      },
    });
    created += 1;
  }

  console.log(
    `Created ${created} org-owned catalog plans across ${hostOrgs.length} organizations`,
  );
}
