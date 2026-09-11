import type { PrismaLike } from "@/lib/prisma";
/**
 * Server-side SSO enforcement decision for BetterAuth `session.create.before`.
 *
 * Runs just before a session cookie is issued (every authenticated path —
 * credential signin, OAuth signin, SSO signin, signup). Returns whether the
 * session creation should be rejected and why. Pure helper — all I/O is
 * injected so this can be unit-tested without a live DB.
 *
 * See issue #673 for the specific bypass this closes.
 *
 * Fails OPEN in one case: the org has `enforceSSO=true` but has not yet
 * registered any `ssoProvider` rows. Locking everyone out mid-setup would
 * trap the org owner after they flip the switch but before they finish
 * adding an IdP.
 */


export type EnforceDecision =
  | { reject: false }
  | { reject: true; reason: "SSO_REQUIRED"; organizationId: string };

export interface EnforcedOrgInfo {
  organizationId: string;
  registeredProviderIds: string[];
}

/**
 * Shared implementation of the `lookupEnforcedOrg` callback. Single
 * source of truth for "given an email domain, which org enforces SSO
 * for it?" used by three call sites that previously duplicated this
 * lookup verbatim (drift was a real risk — see issue #673):
 *
 *   1. `lib/auth.ts` databaseHooks.session.create.before — pre-cookie veto
 *   2. `lib/auth.ts` customSession — defense-in-depth read-time check
 *   3. `app/api/auth/sso/domain-check/route.ts` — unauth pre-login probe
 *
 * Returns `null` (= don't enforce) when any precondition fails:
 *   - No `OrgDomainClaim` row for the domain.
 *   - Claim exists but `verifiedAt IS NULL` (DNS TXT proof missing — a
 *     malicious OWNER who claimed a public domain like `google.com`
 *     without verifying must NOT be able to gate sessions for unrelated
 *     users).
 *   - Owning org is not ACTIVE (PENDING_VERIFICATION, SUSPENDED, DEACTIVATED).
 *   - `OrganizationSSOSettings.enforceSSO` is false.
 *   - `allowedEmailDomains` is set but does not include this domain.
 *
 * Audit Phase B.6. See `docs/enterprise/20-iam-and-security/01-sso-and-authentication.md`.
 */
export async function lookupEnforcedOrg(
  prisma: PrismaLike, // #780 extended client
  domain: string,
): Promise<EnforcedOrgInfo | null> {
  const claim = await prisma.orgDomainClaim.findUnique({
    where: { domain },
    select: {
      organizationId: true,
      verifiedAt: true,
      organization: {
        select: {
          status: true,
          ssoSettings: {
            select: {
              enforceSSO: true,
              allowedEmailDomains: true,
              breakGlassUntil: true,
            },
          },
        },
      },
    },
  });

  if (
    !claim ||
    !claim.verifiedAt ||
    !claim.organization ||
    claim.organization.status !== "ACTIVE" ||
    !claim.organization.ssoSettings?.enforceSSO
  ) {
    return null;
  }

  // #779 §E time-boxed IdP-outage escape hatch — while break-glass is
  // active, don't enforce SSO so password login works for the domain.
  const breakGlassUntil = claim.organization.ssoSettings.breakGlassUntil;
  if (breakGlassUntil && breakGlassUntil > new Date()) {
    return null;
  }

  const allowed = claim.organization.ssoSettings.allowedEmailDomains;
  if (allowed.length > 0 && !allowed.includes(domain)) {
    return null;
  }

  const rows = await prisma.ssoProvider.findMany({
    where: { organizationId: claim.organizationId },
    select: { providerId: true },
  });

  return {
    organizationId: claim.organizationId,
    registeredProviderIds: rows.map((r) => r.providerId),
  };
}

export interface EnforceInputs {
  /** Email of the user attempting to create a session (must already be lowercased). */
  email: string | null | undefined;
  /** The user ID — used to look up the user's linked accounts. */
  userId: string;
  /** Returns org id + allowed provider IDs for the enforcing org, or null if the domain is not enforced. */
  lookupEnforcedOrg: (domain: string) => Promise<{
    organizationId: string;
    registeredProviderIds: string[];
  } | null>;
  /** Returns true if the user has any `account` row whose `providerId` is in the given list. */
  hasAccountInProviders: (
    userId: string,
    providerIds: string[],
  ) => Promise<boolean>;
}

export async function shouldRejectSession(
  inputs: EnforceInputs,
): Promise<EnforceDecision> {
  const email = inputs.email?.toLowerCase();
  const domain = email?.split("@")[1];
  if (!domain) return { reject: false };

  const enforced = await inputs.lookupEnforcedOrg(domain);
  if (!enforced) return { reject: false };

  // Fail-open: org is enforced but has no providers configured yet.
  // Better to let the admin finish setup than to lock the whole domain out.
  if (enforced.registeredProviderIds.length === 0) return { reject: false };

  const linked = await inputs.hasAccountInProviders(
    inputs.userId,
    enforced.registeredProviderIds,
  );
  if (linked) return { reject: false };

  return {
    reject: true,
    reason: "SSO_REQUIRED",
    organizationId: enforced.organizationId,
  };
}
