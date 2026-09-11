/**
 * POST /api/organizations/[orgId]/domain-claims/[domain]/verify
 *
 * Verifies the OWNER actually controls the claimed domain by looking up
 * a TXT record at `_familiarise-verify.<domain>` and confirming it
 * matches the claim's stored `verificationToken`. On match, flips
 * `verifiedAt` from NULL → now() and emits `DOMAIN_VERIFIED` audit.
 *
 * Why this matters: `OrgDomainClaim.domain` is globally unique. Without
 * DNS proof, a malicious OWNER could claim `google.com` purely to
 * intercept SSO domain-check routing for stolen cookies. TXT-proof
 * binds claims to actual domain control.
 *
 * Idempotent: re-running after successful verification is a no-op
 * (`verifiedAt` is stable; the response still returns the record).
 *
 * Non-2xx responses:
 *   - 404: claim not found or not owned by this org
 *   - 422: TXT record missing or doesn't match the stored token (with
 *          `code: "DNS_VERIFICATION_FAILED"`)
 *   - 502: DNS resolution itself failed (transient — retryable)
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { promises as dns } from "node:dns";
import prisma from "@/lib/prisma";
import { requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

export async function POST(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; domain: string }>;
  },
) {
  const { orgId, domain: rawDomain } = await params;
  const domain = decodeURIComponent(rawDomain).toLowerCase().trim();
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const claim = await prisma.orgDomainClaim.findUnique({
    where: { domain },
    select: {
      id: true,
      organizationId: true,
      verificationToken: true,
      verifiedAt: true,
    },
  });
  if (!claim || claim.organizationId !== orgId) {
    return NextResponse.json(
      { error: "Domain claim not found" },
      { status: 404 },
    );
  }

  // Already verified — idempotent return. Don't re-hit DNS.
  if (claim.verifiedAt) {
    return NextResponse.json({
      verifiedAt: claim.verifiedAt,
      alreadyVerified: true,
    });
  }

  if (!claim.verificationToken) {
    // Legacy pre-arch4 claim with no token — flag to caller so UX can
    // route them through a fresh claim flow.
    return NextResponse.json(
      {
        error:
          "This claim was created before DNS verification was required. Re-create the claim to verify ownership.",
        code: "LEGACY_CLAIM_NO_TOKEN",
      },
      { status: 422 },
    );
  }

  const lookupHost = `_familiarise-verify.${domain}`;
  let records: string[][];
  try {
    records = await dns.resolveTxt(lookupHost);
  } catch (err) {
    const isMissing =
      err instanceof Error &&
      "code" in err &&
      (err.code === "ENOTFOUND" || err.code === "ENODATA");
    if (isMissing) {
      return NextResponse.json(
        {
          error: `No TXT record found at ${lookupHost}. Add the record shown on the claim and retry.`,
          code: "DNS_VERIFICATION_FAILED",
        },
        { status: 422 },
      );
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "organizations" } });
    console.error(
      JSON.stringify({
        event: "domain_verify_dns_resolve_failed",
        orgId,
        domain,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return NextResponse.json(
      {
        error: "DNS lookup failed — please retry in a moment.",
        code: "DNS_RESOLVE_ERROR",
      },
      { status: 502 },
    );
  }

  // `resolveTxt` returns `string[][]` — each inner array is a single
  // record's chunks (DNS TXT chunks are 255-byte max, so long values
  // span multiple chunks). We look for any record whose concatenated
  // chunks equal the expected token.
  const expected = claim.verificationToken;
  const matched = records.some(
    (chunks) => chunks.join("").trim() === expected,
  );
  if (!matched) {
    return NextResponse.json(
      {
        error: `TXT record at ${lookupHost} did not match the expected token. Check the value on your DNS provider and retry.`,
        code: "DNS_VERIFICATION_FAILED",
        observedCount: records.length,
      },
      { status: 422 },
    );
  }

  const verifiedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.orgDomainClaim.update({
      where: { id: claim.id },
      data: { verifiedAt },
    });
    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "SETTINGS",
        action: AUDIT_ACTIONS.SETTINGS.DOMAIN_VERIFIED,
        description: `Domain '${domain}' verified via DNS TXT`,
        details: { domain, claimId: claim.id },
      },
    });
  });

  return NextResponse.json({ verifiedAt, alreadyVerified: false });
}
