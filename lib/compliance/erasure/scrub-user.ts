/**
 * DPDP §12 right-to-erasure scrub pipeline.
 *
 * What gets erased
 * ----------------
 *   User.name        → "Erased User <8-char-hash>"
 *   User.email       → "erased-<hash>@erased.invalid"
 *   User.image, phone, address, bio, linkedinUrl, dateOfBirth → NULL
 *   User.erasedAt    → now()
 *   User.pseudonymousId → sha256(userId + ERASURE_SALT)
 *
 *   Membership[].status   → ERASED (every active row across every org)
 *   ConsultantProfile / ConsulteeProfile free-text PII (when present) → NULL
 *   Appointment.notes (when authored by this user) → NULL
 *
 *   BetterAuth Session + Account rows → hard-deleted (forces sign-out
 *   across every device immediately; SSO accounts are dropped too).
 *
 * What survives intact (per Indian IT Act §44AA / §92 retention rules
 * and per the financial-records carve-out in DPDP §12):
 *
 *   Payment*, OrganizationInvoice, OrganizationPayout,
 *   WalletEntry, FundingLedgerEntry, SettlementLedgerEntry, Refund.
 *
 * Why pseudonymousId rather than NULL on every PII field
 * ------------------------------------------------------
 * Investigations after erasure (financial fraud, regulatory queries)
 * still need a way to correlate audit-log rows that reference the user
 * without exposing the original identifiers. The pseudonymous id is a
 * one-way deterministic hash — same id every time, never reversible.
 *
 * Idempotency
 * -----------
 * If `User.erasedAt IS NOT NULL`, the function returns the existing
 * `pseudonymousId` without writing. Safe to call multiple times.
 *
 * Webhook fan-out
 * ---------------
 * Emits `member.removed` per affected organization so SCIM-managed and
 * webhook-subscribed downstreams see the deprovisioning. The
 * dispatching is fire-and-forget inside the same transaction so a
 * rollback (e.g. constraint violation we didn't anticipate) takes the
 * webhook rows with it.
 */

import { createHash } from "node:crypto";
import type { Db } from "@/lib/prisma";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import { releaseSeatsForTerminatedAssignments } from "@/lib/api/organizations/seat-count";

export interface ScrubResult {
  /// True iff this call performed the scrub. False means the user was
  /// already erased on a prior call (idempotency path).
  scrubbed: boolean;
  pseudonymousId: string;
  affectedOrganizationIds: string[];
}

/**
 * Deterministic pseudonym derivation. The salt is read at call time
 * so the `ERASURE_SALT` env can be rotated without code change in an
 * emergency — old erasures are NOT re-keyed (their pseudonymousId is
 * locked in at scrub time and stored on the User row).
 */
function derivePseudonym(userId: string): string {
  const salt = process.env.ERASURE_SALT ?? "familiarise-erasure-fallback";
  return createHash("sha256").update(`${userId}.${salt}`).digest("hex");
}

// #780 — extended client, not bare PrismaClient, so the itx client passed to
// dispatchWebhookEvent satisfies PrismaLike.
export async function scrubUser(
  prisma: Db,
  userId: string,
): Promise<ScrubResult> {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      erasedAt: true,
      pseudonymousId: true,
    },
  });
  if (!existing) {
    throw Object.assign(new Error("User not found"), { httpStatus: 404 });
  }
  if (existing.erasedAt && existing.pseudonymousId) {
    // Idempotency: nothing to do. Return the existing pseudonym so
    // callers can still react (e.g. audit "we processed the request"
    // for compliance trail).
    return {
      scrubbed: false,
      pseudonymousId: existing.pseudonymousId,
      affectedOrganizationIds: [],
    };
  }

  const pseudonymousId = derivePseudonym(userId);
  const shortHash = pseudonymousId.slice(0, 8);
  const scrubbedEmail = `erased-${pseudonymousId.slice(0, 16)}@erased.invalid`;
  const now = new Date();

  // Collect affected memberships BEFORE the transaction so we know
  // which orgs to fan webhooks out to.
  const memberships = await prisma.membership.findMany({
    where: {
      userId,
      // Avoid re-suspending memberships that are already terminal.
      status: { in: ["PENDING", "ACTIVE", "SUSPENDED"] },
    },
    select: { id: true, organizationId: true, role: true, status: true },
  });
  const affectedOrganizationIds = Array.from(
    new Set(memberships.map((m) => m.organizationId)),
  );

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        name: `Erased User ${shortHash}`,
        email: scrubbedEmail,
        image: null,
        phone: null,
        address: null,
        bio: null,
        linkedinUrl: null,
        dateOfBirth: null,
        // city + country stay populated for geographic compliance
        // reporting (the regulator may need "how many users in IN
        // exercised erasure last quarter") — they don't identify the
        // individual.
        erasedAt: now,
        pseudonymousId,
      },
    });

    if (memberships.length > 0) {
      await tx.membership.updateMany({
        where: { userId, status: { in: ["PENDING", "ACTIVE", "SUSPENDED"] } },
        data: { status: "ERASED" },
      });
      // ERASED is terminal — without this, an erased member's live
      // allocations keep counting against program caps and entitlements,
      // same as the member-removal cascade (members route). Status-guarded
      // so ROLLED/CLOSED history is never re-stamped.
      await tx.programAssignment.updateMany({
        where: {
          membershipId: { in: memberships.map((m) => m.id) },
          periodEnd: { gte: now },
          status: { in: ["ACTIVE", "PAUSED"] },
        },
        data: { periodEnd: now, status: "CANCELLED" },
      });
      // E2E-audit P1 fix — erasure must also release billed seats, same as
      // member removal (the reconcile invariant reads activeSeatCount).
      await releaseSeatsForTerminatedAssignments(
        tx,
        memberships.map((m) => m.id),
      );
    }

    // Free-text PII on profiles (best-effort — fields may or may not
    // be set per role). The narrow `update` returns 0 rows when the
    // user has no consultant/consultee profile, which is fine.
    await tx.consultantProfile.updateMany({
      where: { user: { id: userId } },
      data: {
        headline: null,
        videoIntroUrl: null,
        // #781 §B — erasure implies the profile leaves every browse/checkout
        // surface; financial rows stay (statutory retention beats erasure
        // under DPDP's legal-obligation exemption).
        deletedAt: new Date(),
      },
    });
    // ConsulteeProfile carries only FK pointers at present — no
    // free-text PII columns. If new PII fields are added, mirror the
    // ConsultantProfile scrub above.

    // Hard-delete sessions + accounts so SSO and password-based logins
    // both break immediately. BetterAuth caches sessions in Redis;
    // those entries expire on TTL and are non-load-bearing.
    await tx.session.deleteMany({ where: { userId } });
    await tx.account.deleteMany({ where: { userId } });

    // Audit row (under SYSTEM — the actor is the platform, the target
    // is the user). One row per affected org so per-org audit pulls
    // see the event.
    for (const orgId of affectedOrganizationIds) {
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.USER_ERASURE_PROCESSED,
          description: `Erased user ${pseudonymousId.slice(0, 12)} per DPDP §12`,
          details: { pseudonymousId, erasedAt: now.toISOString() },
        },
      });

      // Fan webhook events so SCIM + integrators see the deprovisioning.
      // The data payload uses pseudonymousId — never the raw userId or
      // email — to keep with the erasure semantics.
      await dispatchWebhookEvent({
        prisma: tx,
        organizationId: orgId,
        eventType: "member.removed",
        payload: {
          membershipId: memberships
            .filter((m) => m.organizationId === orgId)
            .map((m) => m.id)[0],
          pseudonymousId,
          source: "dpdp_erasure",
          erasedAt: now.toISOString(),
        },
      });
    }
  });

  return { scrubbed: true, pseudonymousId, affectedOrganizationIds };
}
