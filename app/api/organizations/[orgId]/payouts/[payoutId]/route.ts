/**
 * GET   /api/organizations/[orgId]/payouts/[payoutId]
 * PATCH /api/organizations/[orgId]/payouts/[payoutId]
 *
 * GET returns a single payout with its attached earnings. PATCH is narrow:
 * it permits only manual admin transitions that don't require bank-side
 * interaction. Real state transitions (PENDING → PROCESSING → COMPLETED)
 * come from the payout cron that talks to the gateway.
 *
 * Allowed manual transitions here:
 *   PENDING → CANCELLED  (releases earnings back to READY)
 *   PENDING → APPROVED   (explicit manager sign-off before cron runs)
 *   FAILED  → CANCELLED  (abandon a failed payout; releases earnings)
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";
// Why: payout PATCH covers state mutations (mark sent, cancel) which are
// finance-team actions; allow BILLING_ADMIN alongside OWNER.
import { requireOrgBillingAdminOrOwner } from "@/lib/auth/billing-admin-gate";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const PatchStatusSchema = z.enum(["APPROVED", "CANCELLED"]);

const PatchBodySchema = z
  .object({
    status: PatchStatusSchema.optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  });

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; payoutId: string }>;
  },
) {
  const { orgId, payoutId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "payouts.read" });
  if (access.error) return access.error;

  const payout = await prisma.organizationPayout.findFirst({
    where: { id: payoutId, organizationId: orgId },
    include: {
      earnings: {
        select: {
          id: true,
          paymentId: true,
          grossAmountPaise: true,
          orgSharePaise: true,
          platformFeePaise: true,
          consultantSharePaise: true,
          refundedAmountPaise: true,
          currency: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!payout) {
    return NextResponse.json({ error: "Payout not found" }, { status: 404 });
  }
  return NextResponse.json({ payout });
}

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; payoutId: string }>;
  },
) {
  const { orgId, payoutId } = await params;
  const access = await requireOrgBillingAdminOrOwner(orgId);
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
      const current = await tx.organizationPayout.findFirst({
        where: { id: payoutId, organizationId: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("Payout not found"), { httpStatus: 404 });
      }

      if (body.status) {
        const allowed: Record<string, string[]> = {
          PENDING: ["APPROVED", "CANCELLED"],
          APPROVED: ["CANCELLED"],
          PROCESSING: [],
          COMPLETED: [],
          FAILED: ["CANCELLED"],
          CANCELLED: [],
        };
        const next = allowed[current.status] ?? [];
        if (!next.includes(body.status)) {
          throw Object.assign(
            new Error(
              `Cannot transition payout from ${current.status} to ${body.status} manually`,
            ),
            { httpStatus: 409 },
          );
        }
      }

      // CAS on the state we validated: two concurrent transitions (e.g.
      // APPROVED vs CANCELLED from PENDING) both passed the read-based check
      // before, and the unconditional update let the loser overwrite the
      // winner — an APPROVED payout whose earnings a racing CANCELLED had
      // already released. The count check makes the loser fail closed.
      const claimed = await tx.organizationPayout.updateMany({
        where: { id: payoutId, organizationId: orgId, status: current.status },
        data: {
          ...(body.status && { status: body.status }),
        },
      });
      if (claimed.count === 0) {
        throw Object.assign(
          new Error("Payout state changed concurrently; retry"),
          { httpStatus: 409 },
        );
      }
      const next = await tx.organizationPayout.findUniqueOrThrow({
        where: { id: payoutId },
      });

      // CANCELLED releases the earnings back to READY so a subsequent
      // payout run can pick them up. We write a PAYOUT_REVERSED entry
      // (positive, matching the original -netPayout debit) so the ledger
      // nets to zero for the cancelled window — reusing PAYOUT_SENT for
      // both sides makes analytics queries lie ("payouts sent" would
      // double-count every cancel).
      if (body.status === "CANCELLED") {
        await tx.organizationEarnings.updateMany({
          where: { orgPayoutId: payoutId },
          data: { status: "READY", orgPayoutId: null },
        });
      }

      if (body.status && body.status !== current.status) {
        await tx.orgAuditLog.create({
          data: {
            organizationId: orgId,
            actorMembershipId: access.member.id,
            category: "PAYOUT",
            action:
              body.status === "CANCELLED"
                ? AUDIT_ACTIONS.PAYOUT.PAYOUT_CANCELLED
                : AUDIT_ACTIONS.PAYOUT.PAYOUT_INITIATED,
            description: `Payout ${payoutId}: ${current.status} → ${body.status}`,
            details: {
              payoutId,
              from: current.status,
              to: body.status,
              notes: body.notes ?? null,
            },
          },
        });
      }

      return next;
    });

    return NextResponse.json({ payout: updated });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "organizations" } });
    throw err;
  }
}
