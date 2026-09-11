/**
 * Computes the role-driven side effects for a Membership row in a single
 * place: which profile FKs to hydrate, which to clear, and what the
 * default `payoutRecipient` should be.
 *
 * Before this helper, four call sites (POST /members, PATCH
 * /members/[memberId], invitations/accept, SSO auto-join in
 * `lib/auth.ts`) each had their own inline branching for profile FK
 * hydration. PATCH only touched role/status/departmentLabel — so a
 * MANAGER → LEARNER transition left `consulteeProfileId` null and
 * `/my-program` joined nothing. SSO auto-join only hydrated the
 * consultee side; an EXPERT default-role org left
 * `consultantProfileId` null forever.
 *
 * Behavior:
 *   - LEARNER → ensure ConsulteeProfile (lazy-create if missing); clear
 *     `consultantProfileId`; default `payoutRecipient = SELF`.
 *   - EXPERT  → ensure ConsultantProfile (lazy-create with the "General"
 *     placeholder domain + WEEKLY schedule, mirroring the existing
 *     invitation-accept seed); clear `consulteeProfileId`; default
 *     `payoutRecipient = SELF`.
 *   - OWNER / MAINTAINER / MANAGER / SUPPORT → operator roles do not
 *     consume or provide; clear both profile FKs; keep
 *     `payoutRecipient = SELF`.
 *
 * Callers pass the enclosing Prisma transaction. The helper does its
 * profile-side work in the same tx so a failure rolls everything back.
 *
 * The LEARNER↔EXPERT block lives in `lib/enterprise/role-transitions.ts`
 * (`isBlockedRoleTransition`) and is enforced at the route layer — this
 * helper does not re-implement it. By the time the helper runs, the
 * transition is already known to be allowed.
 */

import { ensureConsulteeProfile } from "@/lib/profiles/ensure-consultee-profile";
import type { PrismaLike } from "@/lib/prisma";

export type RoleEffectInput = {
  userId: string;
  role:
    | "OWNER"
    | "MAINTAINER"
    | "BILLING_ADMIN"
    | "MANAGER"
    | "EXPERT"
    | "LEARNER"
    | "SUPPORT";
  /**
   * Optional: pre-fetched profile FKs to skip the lazy-creators' own
   * `findUnique` round-trip when the caller has already loaded the
   * user row. Used by the customSession bareMembers loop in
   * `lib/auth.ts` to avoid an N+1 lookup per bare member. See audit
   * Phase B.7.
   *
   * If a value is `null` the helper still attempts the lazy-create
   * (e.g. LEARNER role + null consulteeProfileId → INSERT). If a value
   * is set, the helper returns it as-is without re-fetching.
   */
  preloadedProfiles?: {
    consulteeProfileId: string | null;
    consultantProfileId: string | null;
  };
};

export type RoleEffectResult = {
  consulteeProfileId: string | null;
  consultantProfileId: string | null;
  payoutRecipient: "SELF" | "ORGANIZATION";
};

/**
 * Returns the consultee/consultant FK values + payoutRecipient default
 * for the target role. For LEARNER and EXPERT, lazy-creates the matching
 * profile when the user does not already have one.
 *
 * The caller is responsible for spreading the returned fields into the
 * `Membership` create/update payload.
 */
export async function applyMembershipRoleEffects(
  tx: PrismaLike,
  input: RoleEffectInput,
): Promise<RoleEffectResult> {
  const { userId, role, preloadedProfiles } = input;

  if (role === "LEARNER") {
    // Fast path: caller already knows the consulteeProfileId.
    const consulteeProfileId =
      preloadedProfiles?.consulteeProfileId ??
      (await ensureConsulteeProfile(tx, userId));
    return {
      consulteeProfileId,
      consultantProfileId: null,
      payoutRecipient: "SELF",
    };
  }

  if (role === "EXPERT") {
    // Fast path: caller already knows the consultantProfileId.
    const consultantProfileId =
      preloadedProfiles?.consultantProfileId ??
      (await ensureConsultantProfile(tx, userId));
    return {
      consulteeProfileId: null,
      consultantProfileId,
      payoutRecipient: "SELF",
    };
  }

  // OWNER / MAINTAINER / BILLING_ADMIN / MANAGER / SUPPORT — operator
  // roles have no consumer or provider profile linkage. Any
  // previously-hydrated FKs are cleared so downstream joins
  // (`/my-program`, `/compensation`, checkout profile resolution)
  // don't pick up stale rows. BILLING_ADMIN sits in this group because
  // it's a finance-only operator role; it has no booking-side surface.
  return {
    consulteeProfileId: null,
    consultantProfileId: null,
    payoutRecipient: "SELF",
  };
}

/**
 * Bump the user's session-generation marker so the next request through
 * `lib/auth.ts:customSession` detects "I'm out of date" and refetches
 * memberships. Use this on every membership mutation that changes the
 * effective permission set (role change, removal, soft-suspend).
 *
 * Why a counter and not a boolean flag
 * ------------------------------------
 * Concurrent role mutations (e.g. a script bulk-promoting interns)
 * race against the customSession reader. A boolean "stale" flag would
 * be cleared by the first reader and miss later mutations. A monotonic
 * integer carried in the session payload means every reader sees an
 * unambiguous "I've seen up to N" check against the current row value.
 *
 * Why we don't force logout
 * -------------------------
 * The UX cost of "you've been signed out, please log in again" is high
 * relative to the marginal security benefit, so removal uses this same
 * generation bump rather than a hard session kill. There is no
 * server-side revoke-by-userId available: the `admin` plugin (which
 * exposes `auth.api.revokeUserSessions({ body: { userId } })`) is not
 * installed, and core BetterAuth `revokeSession`/`revokeSessions` need
 * the target user's own session token/headers — which an admin removing
 * someone else does not hold. This code also runs inside a Prisma
 * `$transaction`, where a BetterAuth API call (writing outside the tx)
 * would be unsound. So membership removal, role downgrade, and
 * soft-suspend all rely on the bump: the next request through
 * `customSession` sees the stale generation and refetches.
 *
 * Failure mode if not called
 * --------------------------
 * The user keeps acting with their old role until BetterAuth's
 * `updateAge: 24h` session-rotation window passes; up to 24h of acting
 * with stale permissions. That's the bug this closes — audit Phase B.5.
 */
export async function bumpUserSessionGeneration(
  tx: PrismaLike,
  userId: string,
): Promise<void> {
  await tx.user.update({
    where: { id: userId },
    data: { sessionGeneration: { increment: 1 } },
  });
}

/**
 * Lazy-create a `ConsultantProfile` for the user. Idempotent: if
 * `user.consultantProfileId` is already set, returns it without
 * writing.
 *
 * Mirrors the seed logic in
 * `app/api/organizations/invitations/accept/route.ts:234-272`. New rows
 * use the "General" placeholder domain + WEEKLY schedule;
 * `verificationStatus` defaults to PENDING_VERIFICATION via the schema
 * default, which keeps the profile hidden from `/explore/experts`
 * until a platform admin reviews.
 */
async function ensureConsultantProfile(
  tx: PrismaLike,
  userId: string,
): Promise<string> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { consultantProfileId: true },
  });
  if (user?.consultantProfileId) return user.consultantProfileId;

  // Guard against seeded users whose ConsultantProfile row exists but
  // User.consultantProfileId was never backfilled (e.g. faker seed data).
  const existing = await tx.consultantProfile.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (existing) {
    await tx.user.updateMany({
      where: { id: userId, consultantProfileId: null },
      data: { consultantProfileId: existing.id },
    });
    return existing.id;
  }

  const placeholderDomain = await tx.domain.upsert({
    where: { name: "General" },
    create: { name: "General" },
    update: {},
    select: { id: true },
  });
  const created = await tx.consultantProfile.create({
    data: {
      userId,
      domainId: placeholderDomain.id,
      scheduleType: "WEEKLY",
    },
    select: { id: true },
  });
  await tx.user.updateMany({
    where: { id: userId, consultantProfileId: null },
    data: { consultantProfileId: created.id },
  });
  return created.id;
}

/**
 * Recompute `ConsultantProfile.isIndependent` from current membership
 * state. Call this AFTER any membership mutation that touches the
 * consultant's EXPERT memberships:
 *   - POST /api/organizations/[orgId]/members (create EXPERT)
 *   - PATCH /api/organizations/[orgId]/members/[memberId] (role / status change)
 *   - DELETE /api/organizations/[orgId]/members/[memberId] (soft-delete)
 *   - invitation accept (create EXPERT via accept flow)
 *   - SSO auto-join (create EXPERT via custom session hook)
 *
 * Rule: `isIndependent = true` iff the consultant has ZERO active EXPERT
 * memberships at HOST-capable orgs (`organization.canHost = true`). The
 * flag drives the "Hosted by X" badge on the marketplace explore page.
 *
 * Idempotent: safe to call multiple times. Only HOST-capable orgs count
 * — a sponsor-only org doesn't host the expert in the marketplace sense.
 *
 * Backfill: `prisma/scripts/backfill-isindependent.ts` walks every
 * ConsultantProfile and runs this once.
 */
export async function recomputeConsultantIsIndependent(
  tx: PrismaLike,
  consultantProfileId: string,
): Promise<void> {
  const activeExpertCount = await tx.membership.count({
    where: {
      consultantProfileId,
      role: "EXPERT",
      status: "ACTIVE",
      organization: { canHost: true },
    },
  });
  await tx.consultantProfile.update({
    where: { id: consultantProfileId },
    data: { isIndependent: activeExpertCount === 0 },
  });
}
