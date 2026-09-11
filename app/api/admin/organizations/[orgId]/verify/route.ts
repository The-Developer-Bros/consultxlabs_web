/**
 * POST /api/admin/organizations/[orgId]/verify
 *
 * Platform-admin action: flip an Organization from PENDING_VERIFICATION
 * to ACTIVE. This is the last-mile gate before an org can create
 * contracts, invite members, or initiate payouts — an admin has reviewed
 * the verification docs (GSTIN, PAN, PO sample) and signed off.
 *
 * Admins can also SUSPEND an active org or REACTIVATE a suspended one.
 * DEACTIVATED is terminal and not reversible from this endpoint.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/auth-helpers";
import { purgeOrgSurfaces } from "@/lib/data/public-cache";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  IllegalTransitionError,
  transitionOrganization,
} from "@/lib/enterprise/transitions";

// #779 §A — `REJECT` added (admin bounces a PENDING org back with a reason;
// stays PENDING_VERIFICATION). Action is upper-cased + defaults to VERIFY so
// the legacy `{}`/missing-action callers keep their verify behavior.
const ActionSchema = z.enum([
  "VERIFY",
  "REJECT",
  "SUSPEND",
  "REACTIVATE",
  "DEACTIVATE",
]);

const BodySchema = z
  .object({
    action: z
      .preprocess(
        (v) => (typeof v === "string" ? v.toUpperCase() : v),
        ActionSchema,
      )
      .default("VERIFY"),
    reason: z.string().max(2000).optional(),
  })
  // Reject requires a reason — it's what the OWNER sees to fix + resubmit.
  .refine((b) => b.action !== "REJECT" || (b.reason && b.reason.length > 0), {
    message: "reason is required when rejecting",
    path: ["reason"],
  });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const auth = await requireAdminAuth();
  if (auth.error) return auth.error;

  const { orgId } = await params;

  const raw = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.organization.findUnique({
        where: { id: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("Organization not found"), {
          httpStatus: 404,
        });
      }

      // Friendly pre-check only — names the offending action/state in the
      // error. Enforcement is the CAS WHERE below: a concurrent admin action
      // landing between this read and the update matches zero rows and 409s
      // instead of resurrecting a terminal state.
      const allowedFrom: Record<string, string[]> = {
        // #779 §A — REJECT keeps the org PENDING (a sub-state, not a status move).
        PENDING_VERIFICATION: ["VERIFY", "REJECT", "DEACTIVATE"],
        ACTIVE: ["SUSPEND", "DEACTIVATE"],
        SUSPENDED: ["REACTIVATE", "DEACTIVATE"],
        DEACTIVATED: [],
      };
      const allowed = allowedFrom[current.status] ?? [];
      if (!allowed.includes(body.action)) {
        throw Object.assign(
          new Error(
            `Cannot ${body.action} an organization in ${current.status} state`,
          ),
          { httpStatus: 409 },
        );
      }

      const actionKey =
        body.action === "VERIFY"
          ? AUDIT_ACTIONS.SYSTEM.VERIFIED
          : body.action === "REJECT"
            ? AUDIT_ACTIONS.SYSTEM.VERIFICATION_REJECTED
            : body.action === "SUSPEND"
              ? AUDIT_ACTIONS.SYSTEM.SUSPENDED
              : body.action === "REACTIVATE"
                ? AUDIT_ACTIONS.SYSTEM.REACTIVATED
                : AUDIT_ACTIONS.SYSTEM.DEACTIVATED;

      if (body.action === "REJECT") {
        // #779 §A — REJECT stamps the resubmit sub-state, not a status move.
        // Guarded on still-PENDING so a concurrent VERIFY can't be overwritten
        // back into rejection.
        const res = await tx.organization.updateMany({
          where: { id: orgId, status: "PENDING_VERIFICATION" },
          data: {
            verificationReason: body.reason,
            verificationRejectedAt: new Date(),
          },
        });
        if (res.count === 0) {
          throw new IllegalTransitionError("Organization", "REJECT");
        }
        await tx.orgAuditLog.create({
          data: {
            organizationId: orgId,
            actorMembershipId: null,
            category: "SYSTEM",
            action: actionKey,
            description: `Admin reject: stays ${current.status}`,
            details: {
              adminUserId: auth.session.user.id,
              from: current.status,
              to: current.status,
              reason: body.reason ?? null,
            },
          },
        });
      } else {
        const nextStatus =
          body.action === "VERIFY" || body.action === "REACTIVATE"
            ? ("ACTIVE" as const)
            : body.action === "SUSPEND"
              ? ("SUSPENDED" as const)
              : ("DEACTIVATED" as const);

        await transitionOrganization(tx, {
          where: { id: orgId },
          to: nextStatus,
          // #779 §A — VERIFY clears the resubmit-loop sub-state.
          data:
            body.action === "VERIFY"
              ? {
                  verificationReason: null,
                  verificationSubmittedAt: null,
                  verificationRejectedAt: null,
                }
              : undefined,
          audit: {
            organizationId: orgId,
            actorMembershipId: null,
            category: "SYSTEM",
            action: actionKey,
            description: `Admin ${body.action.toLowerCase()}: ${current.status} → ${nextStatus}`,
            details: {
              adminUserId: auth.session.user.id,
              from: current.status,
              to: nextStatus,
              reason: body.reason ?? null,
            },
          },
        });
      }

      // updateMany returns no row — re-read in-tx for the response body.
      return tx.organization.findUniqueOrThrow({ where: { id: orgId } });
    });

    // ACTIVE is half the public gate: VERIFY/REACTIVATE put the org into the
    // directory, SUSPEND/DEACTIVATE take it out. (REJECT only stamps sub-state
    // and leaves the org PENDING, so it never reaches here.)
    purgeOrgSurfaces(updated.slug);

    return NextResponse.json({ organization: updated });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
