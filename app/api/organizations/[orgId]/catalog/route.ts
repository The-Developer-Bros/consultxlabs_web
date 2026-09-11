/**
 * GET    /api/organizations/[orgId]/catalog
 * POST   /api/organizations/[orgId]/catalog
 * DELETE /api/organizations/[orgId]/catalog
 *
 * The org's OWN bookable offerings — the plans it authors and owns, as opposed
 * to `/programs`, which is the sponsor-side entitlement that funds bookings of
 * somebody else's plans.
 *
 * #778 collapsed the standalone `OrganizationPlan` table into the per-type
 * plans, so "an org's catalog" is exactly its `WebinarPlan` / `ClassPlan` rows
 * with `organizationId` set. Consultation and Subscription are deliberately
 * absent: both require a `consultantProfileId` in the schema and so can never
 * be solely org-owned. See docs/enterprise/30-programs-and-lifecycle/05-public-pages-and-discovery.md.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { planLevelSchema, planPositioningShape } from "@/schemas/plans";
import { resolveSchedulingTimezone } from "@/lib/scheduling/schedulingTimezone";

const PlanKindSchema = z.enum(["WEBINAR", "CLASS"]);

const VisibilitySchema = z.enum(["PUBLIC", "ORG_ONLY", "ORG_AND_PUBLIC"]);

const RemoveBodySchema = z.object({
  kind: PlanKindSchema,
  planIds: z.array(z.string().min(1)).min(1).max(100),
});

const BaseCreateSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  // Paise. ADR 02 — money is integer paise end to end; the column is BigInt.
  pricePaise: z.number().int().min(0),
  // The EXPERT who delivers. Nullable in the schema, but an org plan nobody
  // can deliver is not bookable, so the endpoint requires it.
  consultantProfileId: z.string().min(1),
  visibility: VisibilitySchema.default("ORG_AND_PUBLIC"),
  maxParticipants: z.number().int().positive().optional(),
  language: z.string().default("English"),
  level: planLevelSchema,
  certificateProvided: z.boolean().default(false),
  recordingEnabled: z.boolean().default(false),
  // Buyer-facing positioning. Optional so the quick-create path stays short,
  // but accepted here so an org plan is not stuck thinner than a personal one.
  ...planPositioningShape,
});

// The two types diverge on their duration grid, which is why this is a
// discriminated union rather than one schema with optional extras: a webinar is
// a single sitting of N hours, a class is a recurring course.
const CreateBodySchema = z.discriminatedUnion("kind", [
  BaseCreateSchema.extend({
    kind: z.literal("WEBINAR"),
    durationInHours: z.number().positive().default(1),
  }),
  BaseCreateSchema.extend({
    kind: z.literal("CLASS"),
    durationInMonths: z.number().int().positive().default(1),
    sessionsPerWeek: z.number().int().positive().default(1),
    sessionDurationInHours: z.number().positive().default(1),
  }),
]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "catalog.manage",
    canHost: true,
  });
  if (access.error) return access.error;

  // Archived plans are hidden unless explicitly asked for, so the catalog reads
  // as "what we currently sell" while the history stays reachable.
  const url = new URL(req.url);
  const includeArchived = url.searchParams.get("includeArchived") === "true";
  const archiveFilter = includeArchived ? {} : { archivedAt: null };

  const [webinars, classes] = await Promise.all([
    prisma.webinarPlan.findMany({
      where: { organizationId: orgId, ...archiveFilter },
      orderBy: { createdAt: "desc" },
      include: { consultantProfile: { select: { id: true, userId: true } } },
    }),
    prisma.classPlan.findMany({
      where: { organizationId: orgId, ...archiveFilter },
      orderBy: { createdAt: "desc" },
      include: { consultantProfile: { select: { id: true, userId: true } } },
    }),
  ]);

  // BigInt is not JSON-serializable — paise cross the wire as strings, matching
  // the money convention the rest of the org surfaces use.
  return NextResponse.json({
    webinars: webinars.map((w) => ({ ...w, price: w.price.toString() })),
    classes: classes.map((c) => ({ ...c, price: c.price.toString() })),
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "catalog.manage",
    canHost: true,
    // Publishing an offering is a commercial act; an unverified org must not
    // put bookable inventory on the marketplace.
    requireActive: true,
  });
  if (access.error) return access.error;

  const parsed = CreateBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // The named deliverer must be an ACTIVE EXPERT of THIS org. Without this an
  // operator could point an org plan at any consultantProfileId on the
  // platform and commit a stranger to delivering it.
  const expert = await prisma.membership.findFirst({
    where: {
      organizationId: orgId,
      status: "ACTIVE",
      role: "EXPERT",
      consultantProfileId: body.consultantProfileId,
    },
    // #1076 — the named deliverer's zone is what a class's caps bucket on.
    select: {
      id: true,
      consultantProfile: { select: { user: { select: { timezone: true } } } },
    },
  });
  if (!expert) {
    return NextResponse.json(
      {
        error: "NOT_AN_ORG_EXPERT",
        message:
          "The selected consultant is not an active EXPERT in this organization.",
      },
      { status: 422 },
    );
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const common = {
        title: body.title,
        subtitle: body.subtitle ?? null,
        description: body.description,
        price: BigInt(body.pricePaise),
        priceCurrency: "INR" as const,
        consultantProfileId: body.consultantProfileId,
        organizationId: orgId,
        visibility: body.visibility,
        language: body.language,
        level: body.level,
        certificateProvided: body.certificateProvided,
        recordingEnabled: body.recordingEnabled,
        targetAudience: body.targetAudience,
        whatsIncluded: body.whatsIncluded,
        faqs: {
          create: body.faqs.map((faq, index) => ({
            question: faq.question,
            answer: faq.answer,
            order: faq.order || index,
          })),
        },
      };

      const plan =
        body.kind === "WEBINAR"
          ? await tx.webinarPlan.create({
              data: {
                ...common,
                durationInHours: body.durationInHours,
                maxParticipants: body.maxParticipants ?? 100,
              },
            })
          : await tx.classPlan.create({
              data: {
                ...common,
                durationInMonths: body.durationInMonths,
                sessionsPerWeek: body.sessionsPerWeek,
                sessionDurationInHours: body.sessionDurationInHours,
                // Kept consistent with the schema's own derivation note
                // (sessionsPerWeek × durationInMonths × 4) so the stored
                // totals never disagree with the grid that produced them.
                totalSessions: body.sessionsPerWeek * body.durationInMonths * 4,
                totalHours:
                  body.sessionsPerWeek *
                  body.durationInMonths *
                  4 *
                  body.sessionDurationInHours,
                maxParticipants: body.maxParticipants ?? 30,
              },
            });

      // Create the sellable INSTANCE too, not just the plan.
      //
      // This route used to author a WebinarPlan/ClassPlan and stop, so an
      // org-authored offering had no Webinar/Class row, no appointment and no
      // slots — it appeared in the catalog and there was nothing to join. It
      // lands in DRAFT because no session has been scheduled yet, which is the
      // honest state and keeps it off the marketplace until someone sets a time.
      if (body.kind === "WEBINAR") {
        await tx.webinar.create({
          data: { status: "DRAFT", webinarPlan: { connect: { id: plan.id } } },
        });
      } else {
        await tx.class.create({
          data: {
            status: "DRAFT",
            classPlan: { connect: { id: plan.id } },
            schedulingTimezone: resolveSchedulingTimezone(
              expert.consultantProfile?.user.timezone,
            ),
          },
        });
      }

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "CATALOG",
          action: AUDIT_ACTIONS.CATALOG.CATALOG_PLAN_CREATED,
          description: `${body.kind === "WEBINAR" ? "Webinar" : "Class"} plan "${plan.title}" added to the catalog`,
          details: {
            planId: plan.id,
            kind: body.kind,
            visibility: body.visibility,
            consultantProfileId: body.consultantProfileId,
          },
        },
      });

      return plan;
    });

    return NextResponse.json(
      { plan: { ...created, price: created.price.toString() } },
      { status: 201 },
    );
  } catch (err) {
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "enterprise" }, extra: { orgId, kind: body.kind } },
    );
    throw err;
  }
}

/**
 * Withdraw plans from the catalog, or put them back.
 *
 * ARCHIVES rather than deletes, always. The plan FK chain is `onDelete:
 * Cascade` the whole way down — `WebinarPlan` → `Webinar` → `Appointment` →
 * `Payment` — so removing a booked plan would physically destroy settled money
 * records. A plan row is also the TERMS of every sale made against it, which
 * past appointments, invoices and earnings still resolve by reading it.
 *
 * There is deliberately no hard-delete path even for a never-booked plan. One
 * code path cannot trip the cascade; two invite a future edit that misses a
 * reference (materials, collaborators) and turns a catalog button into a
 * history shredder. An unused plan simply sits archived, which costs nothing.
 *
 * `?restore=true` reverses it.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "catalog.manage",
    canHost: true,
  });
  if (access.error) return access.error;

  const parsed = RemoveBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { kind, planIds } = parsed.data;
  const restore = new URL(req.url).searchParams.get("restore") === "true";
  const archivedAt = restore ? null : new Date();

  try {
    const count = await prisma.$transaction(async (tx) => {
      // Scoped by organizationId as well as id, so a stolen id from another
      // tenant matches nothing rather than touching their row.
      const scope = { id: { in: planIds }, organizationId: orgId };

      const { count: affected } =
        kind === "WEBINAR"
          ? await tx.webinarPlan.updateMany({
              where: scope,
              data: { archivedAt },
            })
          : await tx.classPlan.updateMany({ where: scope, data: { archivedAt } });

      if (affected > 0) {
        await tx.orgAuditLog.create({
          data: {
            organizationId: orgId,
            actorMembershipId: access.member.id,
            category: "CATALOG",
            action: restore
              ? AUDIT_ACTIONS.CATALOG.CATALOG_PLAN_RESTORED
              : AUDIT_ACTIONS.CATALOG.CATALOG_PLAN_DEACTIVATED,
            description: `${affected} ${kind === "WEBINAR" ? "webinar" : "class"} plan(s) ${restore ? "restored to" : "withdrawn from"} the catalog`,
            details: { kind, planIds },
          },
        });
      }

      return affected;
    });

    return NextResponse.json(restore ? { restored: count } : { archived: count });
  } catch (err) {
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "enterprise" }, extra: { orgId, kind, planIds } },
    );
    throw err;
  }
}
