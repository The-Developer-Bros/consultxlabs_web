/**
 * Lazy-create a `ConsulteeProfile` for the given user and link it via
 * `user.consulteeProfileId`. Idempotent: safe to call on every booking /
 * invite-accept / onboarding step — if the profile already exists, this
 * returns the existing id without writing.
 *
 * Before this helper, the BetterAuth `user.create.after` hook force-
 * created a ConsulteeProfile for every signup (see lib/auth.ts). That
 * meant pure org-operators (UserRole.ORG_WORKSPACE) and consultants dragged
 * around a dangling consumer profile they never used. We now create on
 * first consumer action instead.
 *
 * The helper is transaction-aware — callers must pass `tx` when already
 * inside a `prisma.$transaction` so the profile creation participates in
 * the same atomic unit (booking + profile creation either both commit
 * or neither do).
 *
 * The `upsert` + `user.update` pair is concurrency-safe via the
 * `ConsulteeProfile.userId @unique` constraint; a racing second caller
 * would hit the unique index, fall through to the `update: {}` branch,
 * and end up with the same id.
 */

import type { PrismaLike } from "@/lib/prisma";

export async function ensureConsulteeProfile(
  db: PrismaLike,
  userId: string,
): Promise<string> {
  const profile = await db.consulteeProfile.upsert({
    where: { userId },
    create: { userId },
    update: {},
    select: { id: true },
  });

  // Only write user.consulteeProfileId if it's currently null/stale. We
  // cannot do a blind user.update because it would trigger a row-level
  // update on every call, inflating write traffic. A conditional update
  // via `where: { id, consulteeProfileId: null }` avoids that for the
  // common case where the link was already set.
  await db.user.updateMany({
    where: { id: userId, consulteeProfileId: null },
    data: { consulteeProfileId: profile.id },
  });

  return profile.id;
}
