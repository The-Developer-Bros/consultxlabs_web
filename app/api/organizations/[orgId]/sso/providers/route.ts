/**
 * GET  /api/organizations/[orgId]/sso/providers
 * POST /api/organizations/[orgId]/sso/providers
 *
 * SSO IdP registrations scoped to this organization. Rows live in
 * `SsoProvider` (BetterAuth-managed, not Prisma-owned at auth time — we
 * write it, BetterAuth's sso() plugin reads it). Each row holds the
 * provider-type-specific config as JSON strings (`oidcConfig` /
 * `samlConfig`) so BetterAuth can parse it on login attempts.
 *
 * ACS + metadata URLs are DERIVED from providerId (see
 * lib/sso/derive-urls.ts) — never accepted from the client — so IdP-side
 * setup instructions stay aligned with what BetterAuth actually mounts.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";
import prisma from "@/lib/prisma";
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { createProviderSchema } from "@/lib/sso/provider-schemas";
import { deriveAcsUrl, deriveMetadataUrl } from "@/lib/sso/derive-urls";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  const providers = await prisma.ssoProvider.findMany({
    where: { organizationId: orgId },
    select: {
      id: true,
      providerId: true,
      issuer: true,
      domain: true,
      // `samlConfig` and `oidcConfig` are JSON-encoded strings (see
      // `prisma/schema.prisma` lines 4073-4074). We only need to know
      // *which* is populated to drive ACS URL inference below — the
      // contents stay opaque to the list view (the detail endpoint
      // is the one that decodes + redacts secrets). Audit Phase B.2.
      samlConfig: true,
      oidcConfig: true,
    },
  });

  // Augment each with its derived ACS + metadata URLs so the dashboard
  // doesn't have to re-compute them client-side. Type inference matters
  // because OIDC providers use a different callback path; the
  // pre-audit-B.2 code hardcoded `null` which always picked the SAML
  // URL — fine for SAML providers, wrong for OIDC providers and very
  // confusing for admins configuring OIDC in their IdP console.
  const augmented = providers.map(({ samlConfig, oidcConfig, ...p }) => {
    const type: "saml" | "oidc" | null = samlConfig
      ? "saml"
      : oidcConfig
        ? "oidc"
        : null;
    return {
      ...p,
      acsUrl: deriveAcsUrl(p.providerId, type),
      metadataUrl: deriveMetadataUrl(p.providerId),
    };
  });

  return NextResponse.json({ data: augmented });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = createProviderSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // Cross-check: providerType-specific config must be present.
  if (body.providerType === "saml" && !body.samlConfig) {
    return NextResponse.json(
      { error: "samlConfig is required for providerType=saml" },
      { status: 400 },
    );
  }
  if (body.providerType === "oidc" && !body.oidcConfig) {
    return NextResponse.json(
      { error: "oidcConfig is required for providerType=oidc" },
      { status: 400 },
    );
  }

  try {
    const provider = await prisma.$transaction(async (tx) => {
      // Domain ownership gate — must come BEFORE the dup-providerId
      // check, because a 422 "domain not owned" is the more
      // actionable error to surface for an operator who pasted the
      // wrong domain.
      //
      // Pre-audit-B.3 this org could create an SsoProvider for any
      // domain string. The runtime SSO-enforcement hook at
      // `lib/auth.ts` + `lib/sso/enforce-session.ts` then refused to
      // honor the provider (because no verified OrgDomainClaim
      // existed), but the registration step itself was silent. That
      // "defended by accident" stance leaves the org-admin staring
      // at a registered provider that mysteriously never fires.
      //
      // Explicit gates: 422 DOMAIN_NOT_OWNED if no claim under this
      // org; 422 DOMAIN_NOT_VERIFIED if the claim exists but
      // verifiedAt IS NULL. The auth runtime keeps its
      // belt-and-suspenders check, but now operators see the
      // problem at the point of action.
      const normalizedDomain = body.domain.toLowerCase();
      const claim = await tx.orgDomainClaim.findUnique({
        where: { domain: normalizedDomain },
        select: { organizationId: true, verifiedAt: true },
      });
      if (!claim || claim.organizationId !== orgId) {
        throw Object.assign(
          new Error(
            `Domain '${body.domain}' is not claimed by this organization. Claim and verify the domain first under Settings → SSO → Domains.`,
          ),
          { httpStatus: 422, code: "DOMAIN_NOT_OWNED" },
        );
      }
      if (!claim.verifiedAt) {
        throw Object.assign(
          new Error(
            `Domain '${body.domain}' is claimed but not yet verified. Add the required DNS TXT record and complete verification before registering an SSO provider.`,
          ),
          { httpStatus: 422, code: "DOMAIN_NOT_VERIFIED" },
        );
      }

      const dupProviderId = await tx.ssoProvider.findUnique({
        where: { providerId: body.providerId },
        select: { id: true },
      });
      if (dupProviderId) {
        throw Object.assign(
          new Error(
            `providerId '${body.providerId}' is already in use. Pick a globally-unique slug.`,
          ),
          { httpStatus: 409 },
        );
      }

      const dupDomain = await tx.ssoProvider.findFirst({
        where: { organizationId: orgId, domain: normalizedDomain },
        select: { id: true },
      });
      if (dupDomain) {
        throw Object.assign(
          new Error(
            `Domain '${body.domain}' is already registered with another provider for this org.`,
          ),
          { httpStatus: 409 },
        );
      }

      const created = await tx.ssoProvider.create({
        data: {
          id: randomUUID(),
          providerId: body.providerId,
          issuer: body.issuer,
          domain: body.domain.toLowerCase(),
          organizationId: orgId,
          oidcConfig: body.oidcConfig
            ? JSON.stringify(body.oidcConfig)
            : null,
          samlConfig: body.samlConfig
            ? JSON.stringify(body.samlConfig)
            : null,
        },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SETTINGS",
          action: AUDIT_ACTIONS.SETTINGS.SSO_ENABLED,
          description: `SSO provider '${body.providerId}' (${body.providerType}) registered for domain ${body.domain}`,
          details: {
            providerId: body.providerId,
            providerType: body.providerType,
            domain: body.domain,
            issuer: body.issuer,
          },
        },
      });

      return created;
    });

    return NextResponse.json(
      {
        provider: {
          id: provider.id,
          providerId: provider.providerId,
          issuer: provider.issuer,
          domain: provider.domain,
          acsUrl: deriveAcsUrl(provider.providerId, body.providerType),
          metadataUrl: deriveMetadataUrl(provider.providerId),
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      const code =
        "code" in err && typeof err.code === "string" ? err.code : undefined;
      return NextResponse.json(
        code ? { error: err.message, code } : { error: err.message },
        { status },
      );
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    throw err;
  }
}
