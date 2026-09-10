/**
 * GET    /api/organizations/[orgId]/programs/[programId]/assignments/[assignmentId]
 * PATCH  /api/organizations/[orgId]/programs/[programId]/assignments/[assignmentId]
 * DELETE /api/organizations/[orgId]/programs/[programId]/assignments/[assignmentId]
 *
 * DELETE is narrow: an assignment with recorded BookingUtilizations
 * cannot be deleted — the usage ledger would lose its anchor. Instead,
 * PATCH engagementsUsed / overageCount or let the periodEnd pass naturally.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma, { type Tx } from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { adjustActiveSeatCount } from "@/lib/api/organizations/seat-count";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const PatchBodySchema = z
  .object({
    periodStart: z.coerce.date().optional(),
    periodEnd: z.coerce.date().optional(),
    // #779 §B — end the allocation early WITHOUT removing the member (the
    // member-removal cascade is the only other path). Sets status=CANCELLED,
    // ends the period now, frees the seat. History (utilizations) stays.
    cancel: z.literal(true).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  })
  .refine((v) => !(v.cancel && (v.periodStart || v.periodEnd)), {
    message: "cancel cannot be combined with period edits",
  });

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; programId: string; assignmentId: string }>;
  },
) {
  const { orgId, programId, assignmentId } = await params;
  // Read widened to any ACTIVE member so a LEARNER can see their own
  // assignment details (utilization, limits) without MANAGER access.
  // PATCH/DELETE remain MANAGER+canSponsor.
  const access = await requireOrgAccess(orgId);
  if (access.error) return access.error;
  if (!access.org.canSponsor) {
    return NextResponse.json(
      { error: "Organization does not sponsor programs" },
      { status: 404 },
    );
  }

  const assignment = await prisma.programAssignment.findFirst({
    where: {
      id: assignmentId,
      programId,
      program: { contract: { organizationId: orgId } },
    },
    include: {
      membership: { include: { user: { select: { id: true, name: true, email: true } } } },
      utilizations: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });
  if (!assignment) {
    return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
  }
  return NextResponse.json({ assignment });
}

/**
 * S3776 — the PATCH transaction body extracted so the route handler stays
 * under the complexity budget. Behavior identical to the previous inline
 * version (cancel cascade vs guarded period edit).
 */
/**
 * S3776 — early-cancel branch of the patch, extracted.
 */
async function cancelAssignment(
  tx: Tx,
  ctx: {
    orgId: string;
    programId: string;
    assignmentId: string;
    actorMembershipId: string;
  },
  current: { membershipId: string; periodStart: Date },
) {
  const { orgId, programId, assignmentId, actorMembershipId } = ctx;
  const cancelEnd = new Date(Math.max(Date.now(), current.periodStart.getTime()));
  const claimed = await tx.programAssignment.updateMany({
    where: { id: assignmentId, status: "ACTIVE" },
    data: { status: "CANCELLED", periodEnd: cancelEnd },
  });
  if (claimed.count === 0) {
    throw Object.assign(
      new Error(
        "Assignment is not active (already rolled, closed, or cancelled)",
      ),
      { httpStatus: 409, code: "ASSIGNMENT_NOT_ACTIVE" },
    );
  }
  await adjustActiveSeatCount(tx, { programId, delta: -1 });
  await tx.orgAuditLog.create({
    data: {
      organizationId: orgId,
      actorMembershipId,
      targetMembershipId: current.membershipId,
      category: "PROGRAM",
      action: AUDIT_ACTIONS.PROGRAM.PROGRAM_UNASSIGNED,
      description: `Program assignment cancelled early for program ${programId}`,
      details: { programId, assignmentId, cancelledEarly: true },
    },
  });
  return tx.programAssignment.findUniqueOrThrow({
    where: { id: assignmentId },
  });
}

async function applyAssignmentPatch(
  tx: Tx,
  ctx: {
    orgId: string;
    programId: string;
    assignmentId: string;
    actorMembershipId: string;
    body: z.infer<typeof PatchBodySchema>;
  },
) {
  // actorMembershipId rides ctx for the extracted branches; this scope no
  // longer consumes it directly (S1854).
  const { orgId, programId, assignmentId, body } = ctx;
  const current = await tx.programAssignment.findFirst({
    where: {
      id: assignmentId,
      programId,
      program: { contract: { organizationId: orgId } },
    },
  });
  if (!current) {
    throw Object.assign(new Error("Assignment not found"), {
      httpStatus: 404,
    });
  }

  // #779 §B — early cancellation. Claim only an ACTIVE row so a concurrent
  // cancel / cycle-rollover can't double-free the seat. periodEnd clamps to
  // periodStart for a not-yet-started allocation (no negative period).
  if (body.cancel) {
    return cancelAssignment(tx, ctx, current);
  }

  // S3776 — period-edit branch extracted (see editAssignmentPeriod).
  return editAssignmentPeriod(tx, ctx, current);
}

/**
 * S3776 — guarded period-edit branch of the patch, extracted. Claims only
 * live rows (see the resurrection note inside) and writes the update audit.
 */
async function editAssignmentPeriod(
  tx: Tx,
  ctx: {
    orgId: string;
    programId: string;
    assignmentId: string;
    actorMembershipId: string;
    body: z.infer<typeof PatchBodySchema>;
  },
  current: { membershipId: string; periodStart: Date; periodEnd: Date },
) {
  const { orgId, programId, assignmentId, actorMembershipId, body } = ctx;
  const nextStart = body.periodStart ?? current.periodStart;
  const nextEnd = body.periodEnd ?? current.periodEnd;
  if (nextEnd.getTime() <= nextStart.getTime()) {
    throw Object.assign(new Error("periodEnd must be after periodStart"), {
      httpStatus: 400,
    });
  }
  // #1132 follow-up — period edits must not resurrect terminal rows. A
  // plain update() here let a MAINTAINER extend the period of a
  // ROLLED / CLOSED / CANCELLED assignment, silently re-arming the
  // sponsored-spend entitlement that checkout resolves by window alone.
  // Claim only live rows via CAS, mirroring the cancel path above.
  const claimedPeriod = await tx.programAssignment.updateMany({
    where: {
      id: assignmentId,
      status: { in: ["ACTIVE", "PAUSED"] },
    },
    data: {
      periodStart: nextStart,
      periodEnd: nextEnd,
    },
  });
  if (claimedPeriod.count === 0) {
    throw Object.assign(
      new Error(
        "Assignment is no longer live (rolled, closed, or cancelled); its period can no longer change",
      ),
      { httpStatus: 409, code: "ASSIGNMENT_NOT_LIVE" },
    );
  }
  const next = await tx.programAssignment.findUniqueOrThrow({
    where: { id: assignmentId },
  });
  await tx.orgAuditLog.create({
    data: {
      organizationId: orgId,
      actorMembershipId,
      targetMembershipId: current.membershipId,
      category: "PROGRAM",
      action: AUDIT_ACTIONS.PROGRAM.PROGRAM_ASSIGNMENT_UPDATED,
      description: `Program assignment period updated for program ${programId}`,
      details: {
        programId,
        assignmentId,
        from: {
          periodStart: current.periodStart.toISOString(),
          periodEnd: current.periodEnd.toISOString(),
        },
        to: {
          periodStart: nextStart.toISOString(),
          periodEnd: nextEnd.toISOString(),
        },
      },
    },
  });
  return next;
}

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; programId: string; assignmentId: string }>;
  },
) {
  const { orgId, programId, assignmentId } = await params;
  const access = await requireOrgAccess(orgId, {
    minimumRole: "MAINTAINER",
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
    const updated = await prisma.$transaction(async (tx) =>
      applyAssignmentPatch(tx, {
        orgId,
        programId,
        assignmentId,
        actorMembershipId: access.member.id,
        body,
      }),
    );

    return NextResponse.json({ assignment: updated });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      // Code passthrough so clients can branch on ASSIGNMENT_NOT_LIVE etc.
      // without string-matching messages (parity with supersede/invoices).
      const code = "code" in err ? err.code : undefined;
      return NextResponse.json(
        { error: err.message, ...(code ? { code } : {}) },
        { status },
      );
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    throw err;
  }
}

export async function DELETE(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; programId: string; assignmentId: string }>;
  },
) {
  const { orgId, programId, assignmentId } = await params;
  const access = await requireOrgAccess(orgId, {
    minimumRole: "MAINTAINER",
    canSponsor: true,
  });
  if (access.error) return access.error;

  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.programAssignment.findFirst({
        where: {
          id: assignmentId,
          programId,
          program: { contract: { organizationId: orgId } },
        },
        include: { _count: { select: { utilizations: true } } },
      });
      if (!current) {
        throw Object.assign(new Error("Assignment not found"), {
          httpStatus: 404,
        });
      }
      if (current._count.utilizations > 0) {
        throw Object.assign(
          new Error(
            "Cannot delete an assignment with recorded utilizations. Let the period expire or archive the program instead.",
          ),
          { httpStatus: 409 },
        );
      }
      await tx.programAssignment.delete({ where: { id: assignmentId } });
      // For LICENSED_SEAT programs the seat is freed; for others this is
      // a no-op and `adjustActiveSeatCount` returns applied:false.
      await adjustActiveSeatCount(tx, { programId, delta: -1 });
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          targetMembershipId: current.membershipId,
          category: "PROGRAM",
          action: AUDIT_ACTIONS.PROGRAM.PROGRAM_UNASSIGNED,
          description: `Unassigned ${current.membershipId} from program ${programId}`,
          details: { programId, assignmentId },
        },
      });
    });
    return new NextResponse(null, { status: 204 });
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
