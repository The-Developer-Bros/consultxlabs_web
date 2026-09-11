/**
 * Stale Invitation Cleanup — Core Logic
 *
 * Transitions PENDING invitations to EXPIRED once their `expiresAt`
 * column has passed. The `Invitation.expiresAt` column is already set
 * at insert time by `POST /api/organizations/[orgId]/invitations`
 * (default is now + 14 days), but without this cron it silently sits
 * past its window and the MAINTAINER still sees it in the "pending"
 * tab — creating the false impression that the invitee might still
 * accept.
 *
 * We only touch rows where:
 *   - `status = "pending"` (don't clobber "accepted" / "revoked")
 *   - `expiresAt < now()`
 *
 * Per-expiry an `OrgAuditLog` row is emitted (MEMBER / INVITE_EXPIRED)
 * so MAINTAINERs can see the lapse on the org's audit trail. The
 * `actorMembershipId` is left NULL because no human triggered this —
 * it's a system action, and the existing audit schema allows the
 * nullable actor column for exactly this case.
 *
 * This module exports the core cleanup function. It is imported by:
 *   - jobs/cleanup/cleanup-stale-invitations.ts (GitHub Actions wrapper)
 *   - app/api/cleanup/stale-invitations/route.ts (HTTP endpoint)
 *
 * Schedule: Daily at 08:10 IST (02:40 UTC; #709 minute map). Runs on its own slot so
 *           it does not overlap cleanup-abandoned-org-top-ups (07:30
 *           IST / 02:00 UTC) or the subscription cron (05:30 IST /
 *           00:00 UTC).
 */

import prisma from "../../lib/prisma";
import { AUDIT_ACTIONS } from "../../lib/enterprise/audit-actions";
import { withCronLock } from "@/lib/cron/with-cron-lock";

export interface StaleInvitationsCleanupResult {
  success: boolean;
  expired: number;
  errors: string[];
  timestamp: string;
}

// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function cleanupStaleInvitations(): Promise<StaleInvitationsCleanupResult> {
  return withCronLock("cleanup-stale-invitations", { failMode: "open" }, () =>
    cleanupStaleInvitationsUnlocked(),
  );
}

async function cleanupStaleInvitationsUnlocked(): Promise<StaleInvitationsCleanupResult> {
  const now = new Date();
  const errors: string[] = [];
  let expired = 0;

  console.log("🧹 Starting stale invitation cleanup...");
  console.log(`   Cutoff: ${now.toISOString()}`);

  try {
    // Identify candidates first so we can emit audit rows per-row. A bulk
    // updateMany would be cheaper, but we'd lose the per-org audit trail
    // which is the whole point of surfacing "this invite lapsed" to the
    // MAINTAINER. Batch size is bounded — stale invites are rare.
    const candidates = await prisma.invitation.findMany({
      where: {
        status: "pending",
        expiresAt: { lt: now },
      },
      select: {
        id: true,
        organizationId: true,
        email: true,
        role: true,
        expiresAt: true,
      },
    });

    if (candidates.length === 0) {
      console.log("   No stale invitations to expire.");
      return {
        success: true,
        expired: 0,
        errors: [],
        timestamp: now.toISOString(),
      };
    }

    console.log(`   Found ${candidates.length} stale invitations.`);

    for (const invite of candidates) {
      try {
        // Why we capture the inner result: the transaction callback
        // can early-return when the concurrency guard sees the invite
        // already flipped to `accepted` between the scan and the
        // status mutation. Without surfacing that signal, the outer
        // counter would over-count + over-audit, telling the operator
        // "expired 1" when nothing actually changed. The
        // pre-PR-#655 cron had this bug — see
        // `__tests__/enterprise/expire-stale-invitations.test.ts`.
        const didExpire = await prisma.$transaction(async (tx) => {
          // Re-read inside the TX to guard against a concurrent accept
          // between the scan above and the status flip here.
          const fresh = await tx.invitation.findUnique({
            where: { id: invite.id },
            select: { status: true },
          });
          if (!fresh || fresh.status !== "pending") return false;

          await tx.invitation.update({
            where: { id: invite.id },
            data: { status: "expired" },
          });

          await tx.orgAuditLog.create({
            data: {
              organizationId: invite.organizationId,
              actorMembershipId: null,
              category: "MEMBER",
              action: AUDIT_ACTIONS.MEMBER.INVITE_EXPIRED,
              description: `Invitation for ${invite.email} auto-expired after its window lapsed`,
              details: {
                invitationId: invite.id,
                email: invite.email,
                role: invite.role,
                expiresAt: invite.expiresAt.toISOString(),
              },
            },
          });
          return true;
        });
        if (didExpire) expired += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`invitation ${invite.id}: ${message}`);
        console.error(
          JSON.stringify({
            event: "stale_invitation_expire_failed",
            invitationId: invite.id,
            organizationId: invite.organizationId,
            message,
          }),
        );
      }
    }

    console.log(`   Expired ${expired}/${candidates.length} invitations.`);
    return {
      success: errors.length === 0,
      expired,
      errors,
      timestamp: now.toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        event: "stale_invitation_cleanup_failed",
        message,
      }),
    );
    return {
      success: false,
      expired,
      errors: [message],
      timestamp: now.toISOString(),
    };
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
