/**
 * GET    /api/organizations/[orgId]/contracts/[contractId]
 * PATCH  /api/organizations/[orgId]/contracts/[contractId]
 * DELETE /api/organizations/[orgId]/contracts/[contractId]
 *
 * Contracts form the root of the Program/Invoice hierarchy, so the
 * DELETE path is narrow: only DRAFT contracts (no programs, no
 * invoices) can be hard-deleted. Active contracts must be TERMINATED
 * via PATCH — the audit trail would otherwise lose continuity.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { transitionContract } from "@/lib/enterprise/transitions";
import { getContractLockState } from "@/lib/enterprise/config-lock";

// Term fields that lock once the contract leaves DRAFT or starts billing
// (#777 §B). `autoRenew` is a safe forward-looking toggle — editable always.
const TERM_FIELDS = [
  "effectiveFrom",
  "effectiveTo",
  "paymentTermsDays",
] as const;

const ContractStatusSchema = z.enum([
  "DRAFT",
  "ACTIVE",
  "EXPIRED",
  "TERMINATED",
]);

const PatchBodySchema = z
  .object({
    status: ContractStatusSchema.optional(),
    signedAt: z.coerce.date().nullable().optional(),
    effectiveFrom: z.coerce.date().optional(),
    effectiveTo: z.coerce.date().nullable().optional(),
    paymentTermsDays: z.coerce.number().int().min(1).max(120).optional(),
    autoRenew: z.coerce.boolean().optional(),
    terms: z.unknown().optional(),
    purchaseOrderId: z.string().min(1).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  });

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; contractId: string }>;
  },
) {
  const { orgId, contractId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "contracts.read",
    canSponsor: true,
  });
  if (access.error) return access.error;

  const contract = await prisma.contract.findFirst({
    where: { id: contractId, organizationId: orgId },
    include: {
      billingAccount: true,
      purchaseOrder: true,
      programs: {
        include: {
          licensedSeatConfig: true,
          creditPoolConfig: true,
          _count: { select: { assignments: true } },
        },
      },
      subscription: true,
    },
  });
  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }
  // Surface the in-use lock so the detail/edit drawer can disable term
  // fields (effective dates, payment terms) without a second round-trip
  // (#777 §B). autoRenew stays editable regardless.
  const { locked } = await getContractLockState(contractId, contract.status);
  return NextResponse.json({ contract: { ...contract, locked } });
}

// TODO(#1332 server-actions): kept as a Route Handler + useMutation to match the
// rest of the dashboard. New first-party form mutations should prefer a Server
// Action (co-located write + revalidate, progressive enhancement) per the
// agreed direction — migrate this when the dashboard converges on that pattern.
export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; contractId: string }>;
  },
) {
  const { orgId, contractId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "contracts.manage",
    canSponsor: true,
  });
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
      const current = await tx.contract.findFirst({
        where: { id: contractId, organizationId: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("Contract not found"), {
          httpStatus: 404,
        });
      }

      // Reject term edits (effective dates, payment terms) once the
      // contract is in use — those terms are committed the moment it's
      // signed or starts billing (#777 §B). autoRenew/status stay open.
      const touchesTerms = TERM_FIELDS.some((f) => body[f] !== undefined);
      if (touchesTerms) {
        const { locked } = await getContractLockState(
          contractId,
          current.status,
          tx,
        );
        if (locked) {
          throw Object.assign(
            new Error(
              "Contract terms are locked once it's signed or billing has started. Only auto-renew can be changed.",
            ),
            { httpStatus: 409, code: "CONTRACT_TERMS_LOCKED" },
          );
        }
      }

      if (body.purchaseOrderId) {
        const po = await tx.purchaseOrder.findUnique({
          where: { id: body.purchaseOrderId },
          select: { organizationId: true },
        });
        if (!po || po.organizationId !== orgId) {
          throw Object.assign(
            new Error("PurchaseOrder does not belong to this organization"),
            { httpStatus: 400 },
          );
        }
      }

      // Anti-orphan guard: terminating an ACTIVE contract that still has
      // ProgramAssignments inside their current cycle would leave those
      // members entitled to a benefit with no parent contract — checkout
      // would then 500 on the assignment lookup. Force the operator to
      // cancel the assignments (or wait for the cycle to roll) before
      // they can terminate. EXPIRED is fine: the cycle naturally ended.
      if (body.status === "TERMINATED" && current.status === "ACTIVE") {
        const now = new Date();
        const liveAssignmentCount = await tx.programAssignment.count({
          where: {
            program: { contractId },
            periodEnd: { gte: now },
          },
        });
        if (liveAssignmentCount > 0) {
          throw Object.assign(
            new Error(
              `Cannot terminate a contract with ${liveAssignmentCount} active assignment(s) in the current cycle. Cancel the assignments first or wait for the cycle to expire.`,
            ),
            { httpStatus: 409 },
          );
        }

        // #779 §A — terminating a contract while invoices billed under it are
        // still owed (ISSUED/OVERDUE) would sever the money trail. DRAFT
        // invoices haven't billed yet, so they don't block.
        const outstandingInvoices = await tx.organizationInvoice.count({
          where: {
            contractId,
            status: { in: ["ISSUED", "OVERDUE"] },
          },
        });
        if (outstandingInvoices > 0) {
          throw Object.assign(new Error("CONTRACT_HAS_OUTSTANDING_INVOICES"), {
            httpStatus: 409,
            code: "CONTRACT_HAS_OUTSTANDING_INVOICES",
            counts: { outstandingInvoices },
          });
        }
      }

      const scalarData = {
        ...(body.signedAt !== undefined && { signedAt: body.signedAt }),
        ...(body.effectiveFrom !== undefined && {
          effectiveFrom: body.effectiveFrom,
        }),
        ...(body.effectiveTo !== undefined && {
          effectiveTo: body.effectiveTo,
        }),
        ...(body.paymentTermsDays !== undefined && {
          paymentTermsDays: body.paymentTermsDays,
        }),
        ...(body.autoRenew !== undefined && { autoRenew: body.autoRenew }),
        ...(body.terms !== undefined && {
          terms: JSON.parse(JSON.stringify(body.terms)),
        }),
        ...(body.purchaseOrderId !== undefined && {
          purchaseOrderId: body.purchaseOrderId,
        }),
      };

      if (body.status !== undefined && body.status !== current.status) {
        // CAS — the allowed-from guard rides the WHERE, so a concurrent
        // transition (or a stale tab re-activating a TERMINATED contract)
        // matches zero rows and 409s. Status transitions get dedicated audit
        // actions so the timeline reads cleanly.
        const action =
          body.status === "ACTIVE"
            ? AUDIT_ACTIONS.CONTRACT.CONTRACT_SIGNED
            : body.status === "TERMINATED"
              ? AUDIT_ACTIONS.CONTRACT.CONTRACT_TERMINATED
              : body.status === "EXPIRED"
                ? AUDIT_ACTIONS.CONTRACT.CONTRACT_EXPIRED
                : AUDIT_ACTIONS.CONTRACT.CONTRACT_CREATED;
        await transitionContract(tx, {
          where: { id: contractId, organizationId: orgId },
          to: body.status,
          data: scalarData,
          audit: {
            organizationId: orgId,
            actorMembershipId: access.member.id,
            category: "CONTRACT",
            action,
            description: `Contract ${contractId}: ${current.status} → ${body.status}`,
            details: {
              contractId,
              from: current.status,
              to: body.status,
            },
          },
        });

        // #779 §A — TERMINATED/EXPIRED cascade: a dead contract takes its
        // programs (ACTIVE → EXPIRED) and their still-ACTIVE assignments
        // (→ CLOSED) down with it, in this same tx, so nothing is left
        // drawing against a dead contract. TERMINATED is operator-initiated
        // mid-cycle and pre-guarded above; EXPIRED may be natural term-end
        // or a manual early close, and this mirrors jobs/contracts/
        // expire-contracts.ts exactly — without it, a manually-expired
        // contract left assignments ACTIVE against it for up to 24h
        // (#1132 follow-up).
        if (body.status === "TERMINATED" || body.status === "EXPIRED") {
          await tx.program.updateMany({
            where: { contractId, status: "ACTIVE" },
            data: { status: "EXPIRED" },
          });
          await tx.programAssignment.updateMany({
            where: { program: { contractId }, status: "ACTIVE" },
            data: { status: "CLOSED" },
          });
        }
      } else if (Object.keys(scalarData).length > 0) {
        await tx.contract.update({
          where: { id: contractId },
          data: scalarData,
        });
      }

      // updateMany returns no row — re-read in-tx for the response body.
      return tx.contract.findUniqueOrThrow({ where: { id: contractId } });
    });

    return NextResponse.json({ contract: updated });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status = typeof err.httpStatus === "number" ? err.httpStatus : 500;
      const code =
        "code" in err && typeof err.code === "string" ? err.code : undefined;
      // #779 §A — forward counts so the UI can render the outstanding-invoice
      // wind-down message alongside the existing terms-lock code.
      const counts =
        "counts" in err && err.counts && typeof err.counts === "object"
          ? err.counts
          : undefined;
      return NextResponse.json(
        {
          error: err.message,
          ...(code && { code }),
          ...(counts && { counts }),
        },
        { status },
      );
    }
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "enterprise" } },
    );
    throw err;
  }
}

export async function DELETE(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; contractId: string }>;
  },
) {
  const { orgId, contractId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "contracts.manage",
    canSponsor: true,
  });
  if (access.error) return access.error;

  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.contract.findFirst({
        where: { id: contractId, organizationId: orgId },
        include: { _count: { select: { programs: true } } },
      });
      if (!current) {
        throw Object.assign(new Error("Contract not found"), {
          httpStatus: 404,
        });
      }
      if (current.status !== "DRAFT") {
        throw Object.assign(
          new Error(
            "Only DRAFT contracts can be deleted. Use PATCH status=TERMINATED for active contracts.",
          ),
          { httpStatus: 409 },
        );
      }
      if (current._count.programs > 0) {
        throw Object.assign(
          new Error("Cannot delete a contract that has programs attached."),
          { httpStatus: 409 },
        );
      }
      await tx.contract.delete({ where: { id: contractId } });
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "CONTRACT",
          action: AUDIT_ACTIONS.CONTRACT.CONTRACT_TERMINATED,
          description: `DRAFT contract ${contractId} deleted`,
          details: { contractId },
        },
      });
    });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status = typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "enterprise" } },
    );
    throw err;
  }
}
