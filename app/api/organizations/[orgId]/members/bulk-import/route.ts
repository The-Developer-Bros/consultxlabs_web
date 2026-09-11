/**
 * POST /api/organizations/[orgId]/members/bulk-import
 *
 * Wave-8 (#1230) — enterprise provisioning. Accepts a JSON array of
 * {email, name} entries and creates LEARNER memberships in bulk.
 *
 * CR #1256 fixes applied:
 * - S3776: per-entry processing extracted to importEntry helper
 * - failed count derived from results (was declared but never incremented)
 * - Each entry runs atomically inside Serializable tx with retry
 * - Role resets to LEARNER on reactivation (no OWNER/MAINTAINER regain)
 *
 * Bulk REMOVE and bulk ROLE-CHANGE remain 405 (anti-lockout risk).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma, UserRole } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import {
  UNVERIFIED_ORG_SEAT_CAP,
  hasVerifiedDomain,
} from "@/lib/enterprise/governance";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { notifyOrgInviteSent } from "@/lib/novu/org-workflows";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

const EntrySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(200),
});

const BodySchema = z.object({
  entries: z.array(EntrySchema).min(1).max(200),
});

interface RowResult {
  email: string;
  ok: boolean;
  membershipId?: string;
  error?: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    minimumRole: "MAINTAINER",
  });
  if (access.error) return access.error;

  if (
    access.org.status === "SUSPENDED" ||
    access.org.status === "DEACTIVATED"
  ) {
    return NextResponse.json({ error: "ORG_NOT_ACTIVE" }, { status: 409 });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Dedupe within batch
  const seen = new Set<string>();
  const deduped = parsed.data.entries.filter((e) => {
    if (seen.has(e.email)) return false;
    seen.add(e.email);
    return true;
  });

  const results: RowResult[] = [];
  let imported = 0;

  for (const entry of deduped) {
    const result = await importEntry(orgId, entry, access.member.id);
    results.push({
      email: entry.email,
      ok: result.ok,
      membershipId: result.membershipId,
      error: result.error,
    });
    if (result.ok) imported++;
  }

  // Auto-send invite emails to successfully imported members (#1230 wave-8).
  // Fire-and-forget per ADR-14 — email failures don't undo the membership.
  const importedEmails = results
    .filter((r) => r.ok && r.membershipId)
    .map((r) => deduped.find((e) => e.email === r.email))
    .filter((e): e is NonNullable<typeof e> => !!e);

  for (const entry of importedEmails) {
    try {
      await notifyOrgInviteSent(entry.email, {
        inviterName: access.member.id,
        orgName: access.org.name,
        role: "LEARNER",
        inviteUrl: `${process.env.NEXT_PUBLIC_APP_URL}/organizations/invite/${orgId}`,
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      });
    } catch {
      // Non-fatal: the membership exists; admin can resend manually.
    }
  }

  return NextResponse.json(
    {
      imported,
      failed: results.filter((r) => !r.ok).length,
      results,
    },
    { status: 200 },
  );
}

// S3776 + CR #1256 r1 — per-entry processing extracted; each entry runs
// atomically inside Serializable tx with retry so concurrent imports cannot
// overshoot the seat cap. Role resets to LEARNER on reactivation so a removed
// OWNER/MAINTAINER can't regain privileged access via bulk import.
async function importEntry(
  orgId: string,
  entry: { email: string; name: string },
  actorMembershipId: string,
): Promise<{ ok: boolean; membershipId?: string; error?: string }> {
  try {
    return await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          let user = await tx.user.findUnique({
            where: { email: entry.email },
            select: { id: true },
          });
          if (!user) {
            user = await tx.user.create({
              data: { email: entry.email, name: entry.name },
              select: { id: true },
            });
          }

          const existing = await tx.membership.findUnique({
            where: {
              userId_organizationId: {
                userId: user.id,
                organizationId: orgId,
              },
            },
            select: { id: true, status: true, role: true },
          });
          if (existing && existing.status !== "REMOVED") {
            return { ok: false as const, error: "Already a member" };
          }

          // Seat cap for unverified domains
          const verified = await hasVerifiedDomain(tx, orgId);
          if (!verified) {
            const activeCount = await tx.membership.count({
              where: { organizationId: orgId, status: "ACTIVE" },
            });
            if (activeCount >= UNVERIFIED_ORG_SEAT_CAP) {
              return {
                ok: false as const,
                error: `Seat cap (${UNVERIFIED_ORG_SEAT_CAP}) reached — verify a domain to add more`,
              };
            }
          }

          if (existing) {
            // Reset role to LEARNER on reactivation
            const claimed = await tx.membership.updateMany({
              where: {
                id: existing.id,
                status: "REMOVED",
                organizationId: orgId,
                role: "LEARNER",
              },
              data: { status: "ACTIVE" },
            });
            if (claimed.count === 0) {
              return {
                ok: false as const,
                error:
                  "Cannot reactivate: non-LEARNER removed membership",
              };
            }
            return { ok: true as const, membershipId: existing.id };
          }

          const created = await tx.membership.create({
            data: {
              userId: user.id,
              organizationId: orgId,
              role: "LEARNER",
              // PENDING until the invitee completes signup and sets a
              // password. The existing invitation-accept flow flips this to
              // ACTIVE. Creating as ACTIVE would produce phantom members
              // who appear on rosters but cannot log in.
              status: "PENDING",
            },
          });
          await tx.orgAuditLog.create({
            data: {
              organizationId: orgId,
              actorMembershipId,
              targetMembershipId: created.id,
              category: "MEMBER",
              action: AUDIT_ACTIONS.MEMBER.MEMBER_ADDED,
              description: `Bulk-imported ${entry.email} as LEARNER`,
            },
          });
          return { ok: true as const, membershipId: created.id };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      ),
    );
  } catch (err) {
    console.error("[bulk-import] entry failed:", err);
    return { ok: false as const, error: "Internal error" };
  }
}
