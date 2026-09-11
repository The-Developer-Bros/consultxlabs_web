import type { PrismaLike } from "@/lib/prisma";
/**
 * Org governance gates (#675, #687).
 *
 * Centralises the "verifiedAt" gating rules that lock high-impact
 * features (SSO, INVOICE billing, bulk seats) behind successful
 * domain verification. The DNS-TXT verification path itself lives in
 * `app/api/organizations/[orgId]/domain-claims/[domain]/verify/route.ts`;
 * this file is the consumer-side: "given an org, may it do X?"
 */

import type { Prisma, PrismaClient } from "@prisma/client";

/** Hard cap on member count for orgs that have not yet verified a
 *  domain. Picks a number high enough for a founding team to onboard
 *  and small enough that domain squatting attacks are uneconomical. */
export const UNVERIFIED_ORG_SEAT_CAP = 5;

/**
 * Default credit limit assigned to new INVOICE-funded orgs that have
 * not yet been verified or paid their first invoice. Defends against
 * the "book everything then ghost" abuse pattern (#687 invoice fraud).
 *
 * Override via env `MAX_INVOICE_BOOKING_PAISE` for staged ramps.
 */
export function getInvoiceCreditLimitPaise(): number {
  const fromEnv = Number(process.env.MAX_INVOICE_BOOKING_PAISE);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 50_000_00; // ₹50,000 default starter limit
}

/**
 * Returns `true` iff the org has at least one OrgDomainClaim with
 * `verifiedAt != null`. Used by:
 *   - SSO settings save
 *   - BillingAccount.fundingSource transition to INVOICE
 *   - Member-cap gate (UNVERIFIED_ORG_SEAT_CAP)
 *
 * Accepts a `tx` so callers inside `$transaction` see the pre-commit
 * state (preventing TOCTOU between an admin verification rollback and
 * a gated operation).
 */
export async function hasVerifiedDomain(
  db: PrismaLike,
  orgId: string,
): Promise<boolean> {
  const verified = await db.orgDomainClaim.findFirst({
    where: {
      organizationId: orgId,
      verifiedAt: { not: null },
    },
    select: { id: true },
  });
  return verified !== null;
}

export class DomainVerificationRequiredError extends Error {
  readonly code = "DOMAIN_VERIFICATION_REQUIRED" as const;
  readonly httpStatus = 403;
  constructor(public feature: "SSO" | "INVOICE_FUNDING" | "BULK_SEATS") {
    super(
      `This action requires a verified domain on the organization (feature: ${feature}).`,
    );
    this.name = "DomainVerificationRequiredError";
  }
}

export async function assertVerifiedDomainOrThrow(
  db: PrismaLike,
  orgId: string,
  feature: "SSO" | "INVOICE_FUNDING" | "BULK_SEATS",
): Promise<void> {
  if (!(await hasVerifiedDomain(db, orgId))) {
    throw new DomainVerificationRequiredError(feature);
  }
}
