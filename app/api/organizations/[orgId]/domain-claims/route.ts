/**
 * GET  /api/organizations/[orgId]/domain-claims
 * POST /api/organizations/[orgId]/domain-claims
 *
 * An OrgDomainClaim maps an email domain (e.g. `wipro.com`) to a single
 * organization, enabling domain-based auto-join during SSO login and
 * invitation flows. Domains are globally unique — two orgs cannot both
 * claim the same domain, since that would make domain→org resolution
 * ambiguous at login time.
 *
 * Two-step verification: POST here records the claim + generates a
 * `verificationToken`. The OWNER places that token at
 * `_familiarise-verify.<domain>` as a DNS TXT record, then calls POST
 * /domain-claims/[domain]/verify to flip `verifiedAt`. Unverified
 * claims are retained for audit but not honored as identity boundaries
 * (SSO auto-join + invite auto-routing require `verifiedAt IS NOT NULL`).
 * The two-step flow protects against an OWNER hijacking a competitor's
 * domain in the global unique-index race — without TXT proof of control,
 * an unverified claim can't do real damage.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { DomainSchema } from "@/lib/enterprise/validators";

/**
 * Generate a domain-verification token. URL-safe base64 without padding
 * gives us ~128 bits of entropy in ~22 characters — plenty for TXT
 * record lookup but short enough to paste into a DNS provider's UI
 * without wrapping.
 */
function generateVerificationToken(): string {
  return `familiarise-verify=${randomBytes(16).toString("base64url")}`;
}

const CreateBodySchema = z.object({
  domain: DomainSchema,
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  const claims = await prisma.orgDomainClaim.findMany({
    where: { organizationId: orgId },
    orderBy: { claimedAt: "desc" },
  });

  return NextResponse.json({ data: claims });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const created = await prisma.$transaction(async (tx) => {
      const existing = await tx.orgDomainClaim.findUnique({
        where: { domain: body.domain },
        include: { organization: { select: { id: true, name: true } } },
      });
      if (existing) {
        const mine = existing.organizationId === orgId;
        throw Object.assign(
          new Error(
            mine
              ? `Domain '${body.domain}' is already claimed by this organization`
              : `Domain '${body.domain}' is already claimed by another organization`,
          ),
          { httpStatus: 409 },
        );
      }

      const verificationToken = generateVerificationToken();
      const claim = await tx.orgDomainClaim.create({
        data: {
          organizationId: orgId,
          domain: body.domain,
          verificationToken,
        },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SETTINGS",
          action: AUDIT_ACTIONS.SETTINGS.DOMAIN_CLAIMED,
          description: `Domain '${body.domain}' claimed (pending DNS verification)`,
          details: { domain: body.domain, claimId: claim.id },
        },
      });

      return claim;
    });

    // Expose the TXT record name + value the OWNER needs to add. The
    // client renders a copy-paste block on the settings page.
    return NextResponse.json(
      {
        domainClaim: created,
        verification: {
          recordName: `_familiarise-verify.${created.domain}`,
          recordValue: created.verificationToken,
          recordType: "TXT",
          instructionsUrl: "/docs/enterprise/20-iam-and-security/01-sso-and-authentication.md",
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    // P2002 race: two concurrent OWNERs claim the same domain at the
    // same instant. The pre-check inside the tx misses one of them
    // because the read-then-write isn't atomic under Read Committed
    // isolation. The unique index on `OrgDomainClaim.domain` is the
    // backstop — surface it as a clean 409 instead of a 500 so the UI
    // can show "Domain already claimed" instead of a generic error.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json(
        {
          error: `Domain '${body.domain}' is already claimed`,
          code: "DOMAIN_ALREADY_CLAIMED",
        },
        { status: 409 },
      );
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    throw err;
  }
}
