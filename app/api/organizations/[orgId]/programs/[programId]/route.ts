/**
 * GET    /api/organizations/[orgId]/programs/[programId]
 * PATCH  /api/organizations/[orgId]/programs/[programId]
 * DELETE /api/organizations/[orgId]/programs/[programId]
 *
 * DELETE is DRAFT-only (same posture as /contracts). Active programs
 * must be PAUSED via PATCH first — this preserves the audit trail and
 * prevents orphaning ProgramAssignments.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma, { type Tx } from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { transitionProgram } from "@/lib/enterprise/transitions";
import { getProgramLockState } from "@/lib/enterprise/config-lock";
import { overageBehaviorUnsupportedReason } from "@/lib/enterprise/reachable-paths";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

const ProgramStatusSchema = z.enum([
  "ACTIVE",
  "PAUSED",
  "EXPIRED",
  "CANCELLED",
]);

const CoveredPlanTypeSchema = z.enum([
  "CONSULTATION",
  "CLASS",
  "WEBINAR",
  "SUBSCRIPTION",
]);

const OverageBehaviorSchema = z.enum(["BLOCK", "CHARGE_MEMBER", "CHARGE_ORG"]);

const PatchBodySchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    status: ProgramStatusSchema.optional(),
    // #777 §B — archive/unarchive (soft-hide; never hard-delete once in use).
    archived: z.boolean().optional(),
    coveredPlanTypes: z.array(CoveredPlanTypeSchema).optional(),
    allowedCategories: z.array(z.string()).optional(),
    // Money config — locked once the program is in use (#777 §B). Type isn't
    // editable post-create (it picks which config table exists); the per-type
    // money fields below route to licensedSeatConfig / creditPoolConfig.
    ratePerSeatPaise: z.coerce.number().int().min(0).optional(),
    coveredEngagementsPerCycle: z.coerce
      .number()
      .int()
      .min(1)
      .nullable()
      .optional(),
    creditBudgetPerCycle: z.coerce.number().int().min(1).optional(),
    overageBehavior: OverageBehaviorSchema.optional(),
    overageSurchargeBps: z.coerce.number().int().min(0).nullable().optional(),
    priceCapPerEngagementPaise: z.coerce
      .number()
      .int()
      .min(0)
      .nullable()
      .optional(),
    maxOveragePerCyclePaise: z.coerce
      .number()
      .int()
      .min(0)
      .nullable()
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  });

// Fields whose edit rewrites already-settled money — gated by the in-use
// lock (#777 §B). `coveredPlanTypes` counts: it decides what a seat covers.
const MONEY_FIELDS = [
  "coveredPlanTypes",
  "ratePerSeatPaise",
  "coveredEngagementsPerCycle",
  "creditBudgetPerCycle",
  "overageBehavior",
  "overageSurchargeBps",
  "priceCapPerEngagementPaise",
  "maxOveragePerCyclePaise",
] as const;

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; programId: string }>;
  },
) {
  const { orgId, programId } = await params;
  // Read widened to any ACTIVE member: a LEARNER assigned to a program
  // needs to see the program's rules (covered plan types, pool balance)
  // to understand what they can book. Mutations stay MANAGER+ below.
  const access = await requireOrgAccess(orgId);
  if (access.error) return access.error;
  if (!access.org.canSponsor) {
    return NextResponse.json(
      { error: "Organization does not sponsor programs" },
      { status: 404 },
    );
  }

  const program = await prisma.program.findFirst({
    where: { id: programId, contract: { organizationId: orgId } },
    include: {
      licensedSeatConfig: true,
      creditPoolConfig: true,
      contract: {
        select: {
          id: true,
          status: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
      },
      _count: { select: { assignments: true } },
    },
  });
  if (!program) {
    return NextResponse.json({ error: "Program not found" }, { status: 404 });
  }
  // Surface the in-use lock so the edit dialog can disable money fields
  // without a second round-trip (#777 §B).
  const { locked } = await getProgramLockState(programId);
  return NextResponse.json({ program: { ...program, locked } });
}

// TODO(#1332 server-actions): kept as a Route Handler + useMutation to match the
// rest of the dashboard. New first-party form mutations should prefer a Server
// Action (co-located write + revalidate, progressive enhancement) per the
// agreed direction — migrate this when the dashboard converges on that pattern.
/**
 * S3776 — PATCH transaction body extracted; the handler keeps auth,
 * pre-checks, and response mapping. Serializable boundary is preserved by
 * the caller (see CR #1234 r5).
 */
async function applyProgramPatch(
  tx: Tx,
  ctx: {
    orgId: string;
    programId: string;
    actorMembershipId: string;
    body: z.infer<typeof PatchBodySchema>;
  },
) {
  const { orgId, programId, actorMembershipId, body } = ctx;
  // Recomputed here: the handler's own copy gates the pre-tx friendly check.
  const touchesMoney = MONEY_FIELDS.some((f) => body[f] !== undefined);
  const current = await tx.program.findFirst({
    where: { id: programId, contract: { organizationId: orgId } },
    include: {
      licensedSeatConfig: true,
      creditPoolConfig: true,
      // #1458 — the funding source decides which overage behaviours can
      // actually be collected, so the merged-config check below needs it.
      contract: {
        select: { billingAccount: { select: { fundingSource: true } } },
      },
    },
  });
  if (!current) {
    throw Object.assign(new Error("Program not found"), {
      httpStatus: 404,
    });
  }

  // Wave-3 TOCTOU closure (#1230) — the pre-transaction lock check above
  // used the global client and can be defeated by a concurrent
  // first-assignment stamping `configLockedAt` between check and write.
  // Money-field writes therefore RE-CHECK against this tx's snapshot.
  if (touchesMoney) {
    const { locked: lockedNow } = await getProgramLockState(programId, tx);
    if (lockedNow) {
      throw Object.assign(
        new Error(
          "Program is in use — money config is locked. Only the name can be changed.",
        ),
        { httpStatus: 409, code: "PROGRAM_CONFIG_LOCKED" },
      );
    }
  }

  // #768 #14/#15 — the create route validates overage combos on the WHOLE
  // config; a piecemeal PATCH could still assemble CHARGE_* with no
  // circuit-breaker ceiling (unbounded liability) or dead knobs. Merge
  // current + patch and re-check the combined state.
  if (touchesMoney) {
    const cfg = current.licensedSeatConfig ?? current.creditPoolConfig;
    const merged = {
      overageBehavior: body.overageBehavior ?? cfg?.overageBehavior ?? "BLOCK",
      overageSurchargeBps:
        body.overageSurchargeBps !== undefined
          ? body.overageSurchargeBps
          : (cfg?.overageSurchargeBps ?? null),
      maxOveragePerCyclePaise:
        body.maxOveragePerCyclePaise !== undefined
          ? body.maxOveragePerCyclePaise
          : (cfg?.maxOveragePerCyclePaise ?? null),
      coveredEngagementsPerCycle:
        body.coveredEngagementsPerCycle !== undefined
          ? body.coveredEngagementsPerCycle
          : (current.licensedSeatConfig?.coveredEngagementsPerCycle ?? null),
    };
    const fail = (message: string) => {
      throw Object.assign(new Error(message), {
        httpStatus: 400,
        code: "INVALID_OVERAGE_CONFIG",
      });
    };
    if (
      current.type === "LICENSED_SEAT" &&
      merged.coveredEngagementsPerCycle == null &&
      (merged.overageBehavior !== "BLOCK" ||
        (merged.overageSurchargeBps ?? 0) > 0 ||
        merged.maxOveragePerCyclePaise != null)
    ) {
      fail(
        "Overage settings have no effect while coveredEngagementsPerCycle is unlimited — clear them or set a cap.",
      );
    }
    if (
      merged.overageBehavior !== "BLOCK" &&
      (merged.coveredEngagementsPerCycle != null ||
        current.type === "CREDIT_POOL") &&
      (merged.maxOveragePerCyclePaise == null ||
        merged.maxOveragePerCyclePaise < 1)
    ) {
      fail(
        `overageBehavior=${merged.overageBehavior} requires a positive maxOveragePerCyclePaise circuit-breaker ceiling.`,
      );
    }
    if (
      merged.overageBehavior === "BLOCK" &&
      (merged.overageSurchargeBps ?? 0) > 0
    ) {
      fail(
        "overageSurchargeBps has no effect with overageBehavior=BLOCK — remove it or pick CHARGE_MEMBER/CHARGE_ORG.",
      );
    }
    // #1458 — same funding-source rule the create route applies, re-checked on
    // the merged config so a patch cannot assemble a combination the create
    // route would have refused.
    const overageReason = overageBehaviorUnsupportedReason(
      current.contract.billingAccount?.fundingSource ?? null,
      merged.overageBehavior,
      // #1458 — merged, so a patch that adds a surcharge to an already-saved
      // wallet CHARGE_ORG programme is refused as readily as one that sets both.
      merged.overageSurchargeBps,
    );
    if (overageReason) fail(overageReason);
  }

  // #777 §B — archiving guard: an archived program is skipped by the cycle
  // engine, so live allocations under it would zombie (never roll, never
  // close). Force the operator to cancel them (or let the cycle end) first.
  if (body.archived === true) {
    const activeAssignments = await tx.programAssignment.count({
      where: {
        programId,
        status: "ACTIVE",
        periodEnd: { gte: new Date() },
      },
    });
    if (activeAssignments > 0) {
      throw Object.assign(
        new Error(
          `Cannot archive a program with ${activeAssignments} active assignment(s). Cancel them or let the cycle end first.`,
        ),
        {
          httpStatus: 409,
          code: "PROGRAM_HAS_ACTIVE_ASSIGNMENTS",
        },
      );
    }
  }

  const programData = {
    ...(body.name !== undefined && { name: body.name }),
    ...(body.archived !== undefined && {
      archivedAt: body.archived ? new Date() : null,
    }),
    ...(body.coveredPlanTypes !== undefined && {
      coveredPlanTypes: body.coveredPlanTypes,
    }),
    ...(body.allowedCategories !== undefined && {
      allowedCategories: body.allowedCategories,
    }),
  };

  if (body.status !== undefined && body.status !== current.status) {
    // CAS — allowed-from rides the WHERE (tenancy via the contract
    // relation), so a concurrent transition or a stale tab reactivating a
    // CANCELLED/EXPIRED program matches zero rows and 409s.
    await transitionProgram(tx, {
      where: { id: programId, contract: { organizationId: orgId } },
      to: body.status,
      data: programData,
    });

    // Cancelling must take the live assignments down in the same tx —
    // otherwise members keep drawing entitlements from a dead program
    // (checkout honors ACTIVE assignments). periodEnd: now mirrors the
    // member-removal cascade so the periodEnd>=now filter dies with the
    // status, not after it.
    let assignmentsCancelled = 0;
    if (body.status === "CANCELLED") {
      const cascaded = await tx.programAssignment.updateMany({
        where: { programId, status: { in: ["ACTIVE", "PAUSED"] } },
        data: { status: "CANCELLED", periodEnd: new Date() },
      });
      assignmentsCancelled = cascaded.count;
    }

    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId,
        category: "PROGRAM",
        action:
          body.status === "PAUSED"
            ? AUDIT_ACTIONS.PROGRAM.PROGRAM_PAUSED
            : body.status === "ACTIVE"
              ? AUDIT_ACTIONS.PROGRAM.PROGRAM_RESUMED
              : body.status === "CANCELLED"
                ? AUDIT_ACTIONS.PROGRAM.PROGRAM_CANCELLED
                : AUDIT_ACTIONS.PROGRAM.PROGRAM_EXPIRED,
        description: `Program ${programId}: ${current.status} → ${body.status}`,
        details: {
          programId,
          from: current.status,
          to: body.status,
          ...(body.status === "CANCELLED" && { assignmentsCancelled }),
        },
      },
    });
  } else if (Object.keys(programData).length > 0) {
    await tx.program.update({
      where: { id: programId },
      data: programData,
    });
  }

  const next = await tx.program.findUniqueOrThrow({
    where: { id: programId },
  });

  // Per-type money fields route to the live config table. `type` is
  // immutable post-create, so the existing config row is the target —
  // unreachable fields (e.g. ratePerSeatPaise on a CREDIT_POOL) are
  // simply absent from the body and skipped.
  if (current.type === "LICENSED_SEAT") {
    const seatData = {
      ...(body.ratePerSeatPaise !== undefined && {
        ratePerSeatPaise: body.ratePerSeatPaise,
      }),
      ...(body.coveredEngagementsPerCycle !== undefined && {
        coveredEngagementsPerCycle: body.coveredEngagementsPerCycle,
      }),
      ...(body.overageBehavior !== undefined && {
        overageBehavior: body.overageBehavior,
      }),
      ...(body.overageSurchargeBps !== undefined && {
        overageSurchargeBps: body.overageSurchargeBps,
      }),
      ...(body.priceCapPerEngagementPaise !== undefined && {
        priceCapPerEngagementPaise: body.priceCapPerEngagementPaise,
      }),
      ...(body.maxOveragePerCyclePaise !== undefined && {
        maxOveragePerCyclePaise: body.maxOveragePerCyclePaise,
      }),
    };
    if (Object.keys(seatData).length > 0) {
      await tx.licensedSeatConfig.update({
        where: { programId },
        data: seatData,
      });
    }
  } else if (current.type === "CREDIT_POOL") {
    const poolData = {
      ...(body.creditBudgetPerCycle !== undefined && {
        creditBudgetPerCycle: body.creditBudgetPerCycle,
      }),
      ...(body.overageBehavior !== undefined && {
        overageBehavior: body.overageBehavior,
      }),
      ...(body.overageSurchargeBps !== undefined && {
        overageSurchargeBps: body.overageSurchargeBps,
      }),
      ...(body.maxOveragePerCyclePaise !== undefined && {
        maxOveragePerCyclePaise: body.maxOveragePerCyclePaise,
      }),
    };
    if (Object.keys(poolData).length > 0) {
      await tx.creditPoolConfig.update({
        where: { programId },
        data: poolData,
      });
    }
  }

  // Archive/unarchive gets its own audit action (#777 §B).
  if (
    body.archived !== undefined &&
    body.archived !== (current.archivedAt != null)
  ) {
    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId,
        category: "PROGRAM",
        action: AUDIT_ACTIONS.PROGRAM.PROGRAM_ARCHIVED,
        description: `Program ${programId} ${body.archived ? "archived" : "unarchived"}`,
        details: { programId, archived: body.archived },
      },
    });
  }
}

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; programId: string }>;
  },
) {
  const { orgId, programId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "programs.manage",
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

  // Reject any money-field edit on a program that's already in use — a
  // retroactive change would rewrite bookings settled at the old terms.
  // `name`/`status`/`allowedCategories` stay editable always (#777 §B).
  const touchesMoney = MONEY_FIELDS.some((f) => body[f] !== undefined);
  if (touchesMoney) {
    const { locked } = await getProgramLockState(programId);
    if (locked) {
      return NextResponse.json(
        {
          error:
            "Program is in use — money config is locked. Only the name can be changed.",
          code: "PROGRAM_CONFIG_LOCKED",
        },
        { status: 409 },
      );
    }
  }

  try {
    // CR #1234 r5 — Serializable gives the configLockedAt re-check a shared
    // conflict boundary with the assignment-creation tx (which stamps the
    // lock): under READ COMMITTED both could commit, letting money terms
    // change under a just-created allocation. Aborts one side with P2034,
    // retried by the house helper.
    const updated = await withSerializableRetry(() =>
      prisma.$transaction(
        (tx) =>
          applyProgramPatch(tx, {
            orgId,
            programId,
            actorMembershipId: access.member.id,
            body,
          }),
        { isolationLevel: "Serializable" },
      ),
    );
    return NextResponse.json({ program: updated });
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

export async function DELETE(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; programId: string }>;
  },
) {
  const { orgId, programId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "programs.manage",
    canSponsor: true,
  });
  if (access.error) return access.error;

  try {
    // Serializable isolation closes the race where assignment-creation
    // and program-deletion run concurrently: both transactions read
    // assignments=0, both proceed, and the delete cascades the
    // newly-created assignment. Postgres detects the read/write
    // dependency cycle under SERIALIZABLE and aborts one with P2034
    // (which Prisma surfaces as a retryable serialization error). The
    // explicit assignment count + utilization check inside the tx still
    // runs first as a fast-fail.
    // #1132 follow-up — transient serialization aborts now retry instead of
    // 500ing the DELETE.
    await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const current = await tx.program.findFirst({
            where: { id: programId, contract: { organizationId: orgId } },
            include: { _count: { select: { assignments: true } } },
          });
          if (!current) {
            throw Object.assign(new Error("Program not found"), {
              httpStatus: 404,
            });
          }
          if (current._count.assignments > 0) {
            throw Object.assign(
              new Error(
                "Cannot delete a program with active assignments. Pause it instead (PATCH status=PAUSED).",
              ),
              { httpStatus: 409 },
            );
          }

          // Even when assignments=0, a current-cycle BookingUtilization
          // can exist via a reversed-but-not-removed history row. Refuse
          // the hard delete if any utilization in the current period is
          // still queryable — the audit trail would otherwise lose its
          // foreign-key target.
          const utilizationStillPresent = await tx.bookingUtilization.findFirst(
            {
              where: { programAssignment: { programId } },
              select: { id: true },
            },
          );
          if (utilizationStillPresent) {
            throw Object.assign(
              new Error(
                "Program has historical utilization rows. Pause via PATCH status=CANCELLED instead of deleting.",
              ),
              { httpStatus: 409 },
            );
          }

          await tx.program.delete({ where: { id: programId } });
          await tx.orgAuditLog.create({
            data: {
              organizationId: orgId,
              actorMembershipId: access.member.id,
              category: "PROGRAM",
              action: AUDIT_ACTIONS.PROGRAM.PROGRAM_DELETED,
              description: `Program ${programId} deleted (no assignments)`,
              details: { programId },
            },
          });
        },
        { isolationLevel: "Serializable" },
      ),
    );
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
