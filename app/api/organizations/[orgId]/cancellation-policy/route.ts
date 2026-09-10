/**
 * GET /api/organizations/[orgId]/cancellation-policy
 * PUT /api/organizations/[orgId]/cancellation-policy
 *
 * An organization's refund ladder, as immutable versions (#1499). The ladder that
 * an org publishes governs the bookings the org FUNDS: its money is what a refund
 * moves, so its terms are the ones that bind. Personal bookings, and event seats on
 * a shared webinar or class Appointment, use the platform ladder.
 *
 * There is no PATCH and no DELETE on purpose. A version is immutable because
 * `Appointment.cancellationPolicyId` points at the exact row a booking was sold
 * under, so an edit publishes a new version and archives the previous one, and
 * "turn our policy off" means publishing the platform ladder as your own.
 *
 * Authorization mirrors where these terms live today. The free-text
 * `defaultCancellationPolicy` is OWNER-only in the org PATCH, and MemberRole has no
 * ADMIN — the admin-equivalent MAINTAINER cannot write policies today — so OWNER is
 * the no-widening floor for the write. Reads follow the org settings surface, which
 * is `settings.manage`.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  MAX_POLICY_TIERS,
  PLATFORM_DEFAULT_TERMS,
  validateTierLadder,
} from "@/lib/payments/operations/cancellation-policy";
import {
  POLICY_TERMS_INCLUDE,
  publishOrgCancellationPolicy,
  termsFromPolicyRow,
} from "@/lib/payments/operations/cancellation-policy-store";

const TierSchema = z.object({
  // A year of notice is already absurd for a consultation; the bound exists so a
  // typo cannot publish a ladder whose top rung nothing ever clears.
  hoursBefore: z.coerce.number().int().min(0).max(8760),
  refundPct: z.coerce.number().min(0).max(100).multipleOf(0.01),
});

const PutBodySchema = z
  .object({
    tiers: z.array(TierSchema).min(1).max(MAX_POLICY_TIERS),
    consultantInitiatedPct: z.coerce
      .number()
      .min(0)
      .max(100)
      .multipleOf(0.01)
      .default(100),
    policyText: z.string().max(5000).nullable().optional(),
  })
  // One ladder rule, shared with the publish helper and the seed, so the editor can
  // never accept a ladder the quote cannot read.
  .superRefine((body, ctx) => {
    const invalid = validateTierLadder(body.tiers);
    if (invalid)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: invalid,
        path: ["tiers"],
      });
  });

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "settings.manage",
  });
  if (access.error) return access.error;

  const row = await prisma.cancellationPolicy.findFirst({
    where: { organizationId: orgId, status: "ACTIVE" },
    orderBy: { version: "desc" },
    select: { ...POLICY_TERMS_INCLUDE.select, createdAt: true },
  });

  return NextResponse.json({
    // Null means this org has never published, in which case the platform ladder
    // applies to its bookings — the client says so rather than showing an empty form.
    policy: row
      ? { ...termsFromPolicyRow(row), createdAt: row.createdAt }
      : null,
    platformDefault: PLATFORM_DEFAULT_TERMS,
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { minimumRole: "OWNER" });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = PutBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    // Publishing is read-then-write (read the current version → archive the ACTIVE
    // row → insert at version + 1). Under the default isolation two concurrent
    // publishes both read version N and both insert N + 1; Serializable makes that
    // interleaving abort and the retry re-runs the loser, exactly as the rate-card
    // bump does.
    const published = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const created = await publishOrgCancellationPolicy(tx, {
            organizationId: orgId,
            tiers: body.tiers,
            consultantInitiatedPct: body.consultantInitiatedPct,
            policyText: body.policyText ?? null,
            publishedByUserId: access.member.userId,
          });

          await tx.orgAuditLog.create({
            data: {
              organizationId: orgId,
              actorMembershipId: access.member.id,
              category: "SETTINGS",
              action: AUDIT_ACTIONS.SETTINGS.CANCELLATION_POLICY_PUBLISHED,
              description: `Cancellation policy published at version ${created.version}`,
              details: {
                policyId: created.id,
                version: created.version,
                tiers: body.tiers,
                consultantInitiatedPct: body.consultantInitiatedPct,
              },
            },
          });

          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    return NextResponse.json(
      { policy: termsFromPolicyRow(published) },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status = typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    // Losing the (organizationId, version) unique means someone else published
    // while this request was in flight. That is not a server fault: re-read the
    // current version and publish again on top of it.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json(
        {
          error:
            "Another version of this policy was published while you were saving; re-read the current policy and try again",
          code: "CANCELLATION_POLICY_VERSION_CONFLICT",
        },
        { status: 409 },
      );
    }
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "enterprise" } },
    );
    throw err;
  }
}
