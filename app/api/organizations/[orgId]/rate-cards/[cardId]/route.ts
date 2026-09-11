/**
 * GET   /api/organizations/[orgId]/rate-cards/[cardId]
 * PATCH /api/organizations/[orgId]/rate-cards/[cardId]
 *
 * A RateCard is append-only where the split is concerned — the bps values
 * must never be mutated once any earning has been settled against them.
 * PATCH therefore only accepts metadata tweaks (`minGrossPaise`,
 * `maxGrossPaise`) and an explicit `effectiveTo` close-out (retire a card
 * without replacing it, e.g. when the program it served was cancelled).
 *
 * To "change" the split, POST a new RateCard — `bumpRateCard` atomically
 * closes the previous card and creates the new one.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
// Why: rate card PATCH (effectiveTo edits, split rotations) is a
// finance-team mutation; downgrade from OWNER-only.
import { requireOrgBillingAdminOrOwner } from "@/lib/auth/billing-admin-gate";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const PatchBodySchema = z
  .object({
    minGrossPaise: z.coerce.number().int().min(0).nullable().optional(),
    maxGrossPaise: z.coerce.number().int().min(0).nullable().optional(),
    // Allow explicit retire — but only FORWARD (can't rewrite history).
    effectiveTo: z.coerce.date().nullable().optional(),
    reason: z.string().max(500).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  });

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; cardId: string }>;
  },
) {
  const { orgId, cardId } = await params;
  const access = await requireOrgAccess(orgId, { minimumRole: "MANAGER", canHost: true });
  if (access.error) return access.error;

  const card = await prisma.rateCard.findFirst({
    where: {
      id: cardId,
      OR: [
        { ownerOrgId: orgId },
        { ownerContract: { organizationId: orgId } },
      ],
    },
    include: {
      ownerContract: {
        select: { id: true, status: true, organizationId: true },
      },
      _count: {
        select: {
          membershipOverrides: true,
          contracts: true,
        },
      },
    },
  });
  if (!card) {
    return NextResponse.json({ error: "RateCard not found" }, { status: 404 });
  }
  return NextResponse.json({ rateCard: card });
}

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; cardId: string }>;
  },
) {
  const { orgId, cardId } = await params;
  const access = await requireOrgBillingAdminOrOwner(orgId, { canHost: true });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.rateCard.findFirst({
        where: {
          id: cardId,
          OR: [
            { ownerOrgId: orgId },
            { ownerContract: { organizationId: orgId } },
          ],
        },
      });
      if (!current) {
        throw Object.assign(new Error("RateCard not found"), {
          httpStatus: 404,
        });
      }

      // Guard against rewriting the past: if effectiveTo is specified,
      // it must be strictly after effectiveFrom and not earlier than now
      // (retiring into the past would invalidate already-settled
      // earnings).
      if (body.effectiveTo !== undefined && body.effectiveTo !== null) {
        const now = new Date();
        if (body.effectiveTo.getTime() <= current.effectiveFrom.getTime()) {
          throw Object.assign(
            new Error(
              "effectiveTo must be after effectiveFrom (rate cards are append-only)",
            ),
            { httpStatus: 409 },
          );
        }
        if (body.effectiveTo.getTime() < now.getTime()) {
          throw Object.assign(
            new Error(
              "Cannot set effectiveTo in the past — retire at 'now' or later",
            ),
            { httpStatus: 409 },
          );
        }
      }

      const next = await tx.rateCard.update({
        where: { id: cardId },
        data: {
          ...(body.minGrossPaise !== undefined && {
            minGrossPaise: body.minGrossPaise,
          }),
          ...(body.maxGrossPaise !== undefined && {
            maxGrossPaise: body.maxGrossPaise,
          }),
          ...(body.effectiveTo !== undefined && {
            effectiveTo: body.effectiveTo,
          }),
        },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "PROGRAM",
          action: AUDIT_ACTIONS.PROGRAM.RATE_CARD_BUMPED,
          description: `RateCard ${cardId} metadata updated`,
          details: {
            rateCardId: cardId,
            minGrossPaise: next.minGrossPaise,
            maxGrossPaise: next.maxGrossPaise,
            effectiveTo: next.effectiveTo,
            reason: body.reason ?? null,
          },
        },
      });

      return next;
    });

    return NextResponse.json({ rateCard: updated });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    throw err;
  }
}
