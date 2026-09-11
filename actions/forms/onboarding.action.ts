"use server";

import { z } from "zod";
import { processOnboardingData } from "@/utils/onboarding-server";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

// Roles a user is allowed to self-select via this action. Privileged
// roles (ADMIN, STAFF) MUST never be reachable from a client-driven
// action — they are assigned by platform operators out-of-band. Today
// only the ORG_WORKSPACE handoff routes through this action; CONSULTANT /
// CONSULTEE selection happens earlier in the form via the regular
// `processOnboardingData` path which does not let the caller pick the
// role string. Keep this list narrow on purpose — if a new self-
// service role needs to flow through here, add it explicitly.
const SELF_SELECTABLE_ONBOARDING_ROLES: ReadonlySet<UserRole> = new Set([
  UserRole.ORG_WORKSPACE,
]);

// `setOnboardingRoleAction`'s `personalInfo` was previously typed but
// not Zod-validated, so the client could write arbitrary strings into
// `User.name`/`phone`/`timezone` (the only three columns the action
// touches). This schema mirrors the Prisma column constraints:
//  - `name` matches FrontendOnboardingBaseSchema (min 1 — the column is
//    `String`, not nullable);
//  - `phone` is `@unique` in Prisma, so we reject the empty string
//    (would collide with anyone who left phone blank);
//  - `timezone` accepts any IANA-shaped string, capped to 64 chars
//    (longest current IANA zone is 32, leaving headroom for `Etc/...`
//    aliases without buying the full IANA database client-side).
//
// `.strict()` so an upstream typo (e.g. `phoneNumber`) fails loud
// rather than silently dropping into `undefined` and bypassing the
// update.
const RoleHandoffPersonalInfoSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(200).optional(),
    phone: z
      .string()
      .trim()
      .min(1, "Phone cannot be empty")
      .max(50)
      .optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const RoleHandoffRoleSchema = z.nativeEnum(UserRole);

// #region Main Server Action
export async function updateOnboardingInformationAction(
  userId: string,
  body: unknown,
): Promise<{ success: boolean; user?: Record<string, unknown>; error?: string; verificationWarning?: string; verificationDeferred?: boolean }> {
  console.log(
    "Server Action: updateOnboardingInformationAction - Delegating to central utils",
  );

  const session = await getSession(true);
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }
  const isPrivileged =
    session.user.role === "ADMIN" || session.user.role === "STAFF";
  if (!isPrivileged && session.user.id !== userId) {
    return { success: false, error: "Forbidden" };
  }

  // Use the central processing function
  // No cookie-cache refresh here: requireOnboarded() reads force-fresh, so it
  // already sees onboardingCompleted / profile ids. A refresh would also be the
  // wrong tool — getSession reads the CALLER's headers, and this action lets an
  // ADMIN/STAFF update someone else, whose session it could not refresh anyway.
  return processOnboardingData(userId, body);
}
// #endregion

/**
 * Persist the user's selected UserRole mid-onboarding. Used by the
 * ORG_WORKSPACE path so step 1's `POST /api/organizations` sees a session
 * with `role = ORG_WORKSPACE` (the API gate rejects anything else).
 *
 * This is scoped narrowly on purpose: only the authenticated user
 * can flip their own row, the caller's id must match the session,
 * and `onboardingCompleted` is left alone — the final Review step
 * handles that via `processOnboardingData` once the org is ready.
 */
export async function setOnboardingRoleAction(
  userId: string,
  role: UserRole,
  personalInfo: { name?: string; phone?: string; timezone?: string },
): Promise<{ success: boolean; error?: string }> {
  const session = await getSession(true);
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }
  if (session.user.id !== userId) {
    return { success: false, error: "Forbidden" };
  }

  // Validate inputs at the action boundary. TypeScript params don't
  // survive the server-action serialiser (the runtime call is a JSON
  // POST with `unknown` payload), so the static `UserRole` /
  // `personalInfo` types are not load-bearing — Zod is.
  const parsedRole = RoleHandoffRoleSchema.safeParse(role);
  if (!parsedRole.success) {
    return { success: false, error: "Invalid role" };
  }
  const parsedInfo = RoleHandoffPersonalInfoSchema.safeParse(personalInfo);
  if (!parsedInfo.success) {
    const first = parsedInfo.error.issues[0];
    return {
      success: false,
      error: first
        ? `${first.path.join(".") || "personalInfo"}: ${first.message}`
        : "Invalid personal info",
    };
  }

  // Reject any role outside the self-selection allowlist. The Prisma
  // enum type alone is not a security boundary — a malicious caller
  // can pass `"ADMIN"` / `"STAFF"` and Zod would happily allow it
  // (the enum exists in Prisma), so the runtime allowlist check is
  // mandatory after the shape check.
  if (!SELF_SELECTABLE_ONBOARDING_ROLES.has(parsedRole.data)) {
    return { success: false, error: "Forbidden" };
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      role: parsedRole.data,
      name: parsedInfo.data.name,
      phone: parsedInfo.data.phone,
      timezone: parsedInfo.data.timezone,
    },
  });

  return { success: true };
}

/**
 * Undo a provisional ORG_WORKSPACE handoff when the user backs out of the
 * create-org wizard. `setOnboardingRoleAction` has to commit the role before
 * the wizard runs (`POST /api/organizations` gates on it), so without this a
 * user who changed their mind stayed on ORG_WORKSPACE with
 * `onboardingCompleted: false` — org-creation rights for someone who never
 * finished onboarding.
 *
 * The revert target is CONSULTEE because that is the `User.role` schema
 * default every account starts on; the real role is written by
 * `processOnboardingData` when onboarding completes.
 *
 * The `where` clause is the safety guard, applied in a single statement so
 * there is no read-then-write race: only a row that is still ORG_WORKSPACE,
 * still un-onboarded, and holds no membership is provisional. A real org owner
 * (who has at least the owner Membership created with their org) is never
 * touched.
 */
export async function resetOnboardingRoleAction(
  userId: string,
): Promise<{ success: boolean; reverted?: boolean; error?: string }> {
  const session = await getSession(true);
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }
  if (session.user.id !== userId) {
    return { success: false, error: "Forbidden" };
  }

  const { count } = await prisma.user.updateMany({
    where: {
      id: userId,
      role: UserRole.ORG_WORKSPACE,
      // The column is nullable, so `false` alone would skip null rows.
      onboardingCompleted: { not: true },
      memberships: { none: {} },
    },
    data: { role: UserRole.CONSULTEE },
  });

  return { success: true, reverted: count > 0 };
}

/**
 * Flip `user.onboardingCompleted = true` after the ORG_WORKSPACE wizard
 * finishes launching their first org. Role + personal info were already
 * committed by `setOnboardingRoleAction`; the owner Membership was
 * created atomically by `POST /api/organizations`. All that's left is
 * the onboarding flag so the session no longer redirects to /form/onboarding.
 */
export async function completeOrgWorkspaceOnboardingAction(
  userId: string,
): Promise<{ success: boolean; error?: string }> {
  const session = await getSession(true);
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }
  if (session.user.id !== userId) {
    return { success: false, error: "Forbidden" };
  }

  await prisma.user.update({
    where: { id: userId },
    data: { onboardingCompleted: true },
  });

  return { success: true };
}
