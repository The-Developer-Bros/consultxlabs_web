/**
 * Shared consultant-facing archive (withdraw) toggle for the four plan
 * families — ConsultationPlan, SubscriptionPlan, WebinarPlan, ClassPlan (#1494).
 *
 * The org-catalog bulk archive (`app/api/organizations/[orgId]/catalog/route.ts`)
 * was the only existing `archivedAt` writer; a sole-owner consultant (a plan
 * with `organizationId: null`) had no path to stop selling an offering. This
 * helper is the one place the archive/restore semantics live so the four
 * per-plan PATCH routes cannot drift from each other.
 *
 * Archiving stops NEW sales only: `archivedAt` already gates discovery
 * (`lib/api/plans/visibility.ts`), plan-list filters
 * (`app/api/plans/shared/plan-filters.ts`) and checkout
 * (`lib/payments/operations/checkout.ts`), but it never touches existing
 * `Appointment`/`Payment` rows.
 */

import { z } from "zod";

export const ArchivePlanBodySchema = z.object({
  archived: z.boolean(),
});

/**
 * Idempotent: archiving an already-archived plan keeps the original
 * withdrawal timestamp instead of bumping it. Restoring is the plain
 * `archivedAt: null` the callers write directly, so this stays a single-
 * intent function rather than a boolean-switched one (sonar S2301).
 */
export function archivedAtForArchive(currentArchivedAt: Date | null): Date {
  return currentArchivedAt ?? new Date();
}

/**
 * `request.json()` rejects on an empty or malformed body, which would reach
 * the routes' outer catch and answer a client fault with a 5xx; every failure
 * here is the same 400 the zod branch already returns.
 */
export async function parsePlanArchiveBody(
  request: Request,
): Promise<
  | { ok: true; archived: boolean }
  | { ok: false; error: string; details?: unknown }
> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }

  const parsed = ArchivePlanBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Validation failed",
      details: parsed.error.issues,
    };
  }
  return { ok: true, archived: parsed.data.archived };
}

/**
 * These four routes are the SOLE-OWNER door. A plan carrying an
 * `organizationId` is governed by the org catalog
 * (`app/api/organizations/[orgId]/catalog/route.ts`), which checks org
 * membership and role through `requireOrgAccess` and scopes its write by
 * `organizationId`; letting the owning consultant through here would withdraw
 * an org-governed offering with no org authorization at all.
 */
export const PLAN_ORG_GOVERNED_RESPONSE = {
  code: "PLAN_ORG_GOVERNED",
  error:
    "This offering is governed by its organisation. Ask an organisation admin to archive or restore it from the organisation catalog.",
} as const;

export const PLAN_ARCHIVE_RESPONSE_NOTE =
  "Archiving stops new bookings only; existing appointments and payments for this plan are unaffected.";
