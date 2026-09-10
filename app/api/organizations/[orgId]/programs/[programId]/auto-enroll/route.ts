/**
 * POST /api/organizations/[orgId]/programs/[programId]/auto-enroll
 *
 * Wave-9 (#1230) — enterprise classroom MVP. Bulk-creates ProgramAssignment
 * rows for an org's ACTIVE members in one call, so a classroom admin can
 * provision a whole cohort into a LICENSED_SEAT / CREDIT_POOL program
 * instead of POSTing /assignments once per member.
 *
 * Composition contract (mirrors the single-assign POST exactly):
 * - MAINTAINER + canSponsor gate; SUSPENDED org → 409 ORG_NOT_ACTIVE
 *   (DEACTIVATED never reaches the route — requireOrgAccess 403s first,
 *   so the arm deliberately does not exist here).
 * - Per-entry Serializable tx with retry (withSerializableRetry), so
 *   concurrent imports cannot double-bump activeSeatCount.
 * - claimProgramAssignment is the only INSERT path: idempotent on the
 *   @@unique(programId, membershipId, periodStart), overlap-rejecting.
 * - adjustActiveSeatCount(+1) and the first-write configLockedAt stamp run
 *   ONLY when created === true.
 * - One OrgAuditLog PROGRAM_ASSIGNED row per enrolled member.
 *
 * Idempotency: the caller supplies an explicit batch-wide periodStart /
 * periodEnd. Re-running the SAME body is a no-op (every row reports
 * created=false → counted as skipped); re-running with a different
 * periodStart that still overlaps reports a per-row 409-style failure via
 * ProgramAssignmentOverlapError. Periods are never server-derived — a
 * derived "now" would silently change the idempotency key across retries.
 *
 * Batch deadline: entries run sequentially, and Netlify caps synchronous
 * functions at 60s. If the budget is exhausted mid-batch the handler stops
 * BEFORE starting another entry and answers with what already committed,
 * flagged truncated:true — an honest partial result beats a platform kill
 * after writes landed but before the response was sent.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { claimProgramAssignment, ProgramAssignmentOverlapError } from "@/lib/api/organizations/program-helpers";
import { adjustActiveSeatCount } from "@/lib/api/organizations/seat-count";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { AUTO_ENROLL_BATCH_DEADLINE_MS } from "@/lib/api/organizations/auto-enroll-config";
import {
  applyRateLimit,
  orgAutoEnrollLimiter,
} from "@/lib/rate-limit";

const BodySchema = z.object({
  membershipIds: z.array(z.string().min(1)).min(1).max(200),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
});

interface RowResult {
  membershipId: string;
  ok: boolean;
  /** true only when THIS call inserted the row (idempotent re-runs are ok+skipped) */
  created?: boolean;
  error?: string;
}

/**
 * Sonar S3776 — the request-shape guards live here so POST reads as
 * gate → validate → loop → respond.
 */
function parseAutoEnrollBody(
  raw: unknown,
): { ok: true; body: z.infer<typeof BodySchema> } | { ok: false; error: NextResponse } {
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: NextResponse.json(
        { error: "Invalid body", detail: parsed.error.flatten() },
        { status: 400 },
      ),
    };
  }
  const body = parsed.data;
  if (body.periodEnd.getTime() <= body.periodStart.getTime()) {
    return {
      ok: false,
      error: NextResponse.json(
        { error: "periodEnd must be after periodStart" },
        { status: 400 },
      ),
    };
  }
  if (body.periodEnd.getTime() <= Date.now()) {
    return {
      ok: false,
      error: NextResponse.json(
        { error: "periodEnd must be in the future" },
        { status: 400 },
      ),
    };
  }
  return { ok: true, body };
}

/** Cross-org guard: the program must belong to this org AND be ACTIVE. */
async function resolveTargetProgram(
  orgId: string,
  programId: string,
): Promise<{ ok: true } | { ok: false; error: NextResponse }> {
  const program = await prisma.program.findFirst({
    where: { id: programId, contract: { organizationId: orgId } },
    select: { id: true, status: true },
  });
  if (!program) {
    return {
      ok: false,
      error: NextResponse.json({ error: "Program not found" }, { status: 404 }),
    };
  }
  if (program.status !== "ACTIVE") {
    return {
      ok: false,
      error: NextResponse.json(
        { error: `Cannot assign to a ${program.status} program` },
        { status: 409 },
      ),
    };
  }
  return { ok: true };
}

export async function POST(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; programId: string }>;
  },
) {
  const { orgId, programId } = await params;
  const access = await requireOrgAccess(orgId, {
    minimumRole: "MAINTAINER",
    canSponsor: true,
  });
  if (access.error) return access.error;

  // SUSPENDED only — DEACTIVATED is unreachable here (requireOrgAccess
  // already answers it with a 403 before this body runs).
  if (access.org.status === "SUSPENDED") {
    return NextResponse.json({ error: "ORG_NOT_ACTIVE" }, { status: 409 });
  }

  const rateLimited = await applyRateLimit(orgAutoEnrollLimiter, orgId);
  if (rateLimited) return rateLimited;

  const parsedBody = parseAutoEnrollBody(await req.json().catch(() => null));
  if (!parsedBody.ok) return parsedBody.error;
  const body = parsedBody.body;

  // Dedupe within batch — a repeated id would otherwise race itself inside
  // its own Serializable tx and report one create + one duplicate.
  const seen = new Set<string>();
  const deduped = body.membershipIds.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const targetProgram = await resolveTargetProgram(orgId, programId);
  if (!targetProgram.ok) return targetProgram.error;

  const results: RowResult[] = [];
  let enrolled = 0;
  let skipped = 0;
  const startedAt = Date.now();
  let truncated = false;

  for (const membershipId of deduped) {
    // Netlify caps synchronous functions at 60s. Stop BEFORE starting an
    // entry we might not finish and answer with what already committed.
    if (Date.now() - startedAt > AUTO_ENROLL_BATCH_DEADLINE_MS) {
      truncated = true;
      break;
    }
    try {
      const outcome = await enrollOne({
        orgId,
        programId,
        membershipId,
        actorMembershipId: access.member.id,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
      });
      results.push({
        membershipId,
        ok: true,
        created: outcome.created,
      });
      if (outcome.created) enrolled++;
      else skipped++;
    } catch (err) {
      if (err instanceof ProgramAssignmentOverlapError) {
        results.push({
          membershipId,
          ok: false,
          error: "An overlapping assignment already covers this period",
        });
        continue;
      }
      if (err instanceof EnrollRowError) {
        results.push({ membershipId, ok: false, error: err.message });
        continue;
      }
      console.error("[auto-enroll] entry failed:", err);
      results.push({ membershipId, ok: false, error: "Internal error" });
    }
  }

  return NextResponse.json(
    {
      enrolled,
      skipped,
      failed: results.filter((r) => !r.ok).length,
      truncated,
      results,
    },
    { status: 200 },
  );
}

/**
 * One member's enrollment as a single Serializable transaction. Mirrors
 * assignments/route.ts POST tx-for-tx: claim → seat bump on create →
 * config-lock stamp on create → audit. Any thrown error aborts only this
 * member's row; the batch continues.
 */
async function enrollOne(params: {
  orgId: string;
  programId: string;
  membershipId: string;
  actorMembershipId: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<{ created: boolean }> {
  const {
    orgId,
    programId,
    membershipId,
    actorMembershipId,
    periodStart,
    periodEnd,
  } = params;
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const membership = await tx.membership.findFirst({
          where: { id: membershipId, organizationId: orgId },
          select: { id: true, status: true },
        });
        if (!membership) {
          throw new EnrollRowError(
            "Membership does not belong to this organization",
          );
        }
        if (membership.status !== "ACTIVE") {
          // PENDING invitees haven't accepted; SUSPENDED/REMOVED/ERASED must
          // never gain entitlements. Reactivation re-opens the door honestly.
          throw new EnrollRowError("Membership is not ACTIVE");
        }

        const { assignment, created } = await claimProgramAssignment(tx, {
          programId,
          membershipId,
          periodStart,
          periodEnd,
        });

        if (created) {
          await adjustActiveSeatCount(tx, { programId, delta: +1 });
          // #779 — first genuine assignment freezes LOCKED_PROGRAM_FIELDS;
          // gated on configLockedAt:null so re-stamps are no-ops.
          await tx.program.updateMany({
            where: { id: programId, configLockedAt: null },
            data: { configLockedAt: new Date() },
          });
        }

        await tx.orgAuditLog.create({
          data: {
            organizationId: orgId,
            actorMembershipId,
            targetMembershipId: membershipId,
            category: "PROGRAM",
            action: AUDIT_ACTIONS.PROGRAM.PROGRAM_ASSIGNED,
            description: `Auto-enrolled membership ${membershipId} into program ${programId}${
              created ? "" : " (already assigned — idempotent skip)"
            }`,
            details: {
              programId,
              membershipId,
              source: "auto-enroll",
              assignmentId: assignment.id,
              periodStart: periodStart.toISOString(),
              periodEnd: periodEnd.toISOString(),
            },
          },
        });

        return { created };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Row-level validation failure — message becomes the per-row error string. */
class EnrollRowError extends Error {}
