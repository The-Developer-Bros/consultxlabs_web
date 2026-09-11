/**
 * GET   /api/organizations/[orgId]/sso
 * PATCH /api/organizations/[orgId]/sso
 *
 * Org-level SSO settings (separate from the individual IdP configs under
 * /sso/providers). This endpoint governs:
 *   - allowedEmailDomains      — which domains qualify for auto-join
 *   - enforceSSO               — require SSO for all sign-ins
 *   - defaultRoleForAutoJoin   — role newly auto-joined users receive
 *
 * Settings are upserted on PATCH — the record exists 1:1 with Organization,
 * and missing == defaults (empty domains / no enforcement / LEARNER default).
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma, { type Tx } from "@/lib/prisma";
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { DomainSchema } from "@/lib/enterprise/validators";
import { JitDefaultRoleSchema } from "@/lib/labels/org-labels";
import {
  DomainVerificationRequiredError,
  hasVerifiedDomain,
} from "@/lib/enterprise/governance";

const PatchBodySchema = z
  .object({
    allowedEmailDomains: z.array(DomainSchema).max(50).optional(),
    enforceSSO: z.boolean().optional(),
    // JIT auto-join is locked to LEARNER. Admins promote new members
    // explicitly after first signin via /dashboard/.../members. This
    // closes a privilege-escalation hole where `defaultRoleForAutoJoin
    // = "OWNER"` would make the first SSO user co-owner. See audit
    // Phase A.1 + docs/enterprise/20-iam-and-security/01-sso-and-authentication.md.
    defaultRoleForAutoJoin: JitDefaultRoleSchema.optional(),
    // Optimistic-lock clock. When present, a concurrent admin PATCH that
    // already bumped the version 409s instead of silently clobbering.
    expectedVersion: z.coerce.number().int().min(1).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "expectedVersion"), {
    message: "PATCH body must contain at least one field",
  });

type PatchBody = z.infer<typeof PatchBodySchema>;
type SsoSettingsRow = NonNullable<
  Awaited<ReturnType<typeof prisma.organizationSSOSettings.findUnique>>
>;

// Optimistic lock — two admins editing SSO settings from stale tabs would
// last-write-wins the enforcement/domain config without this. The version bump
// is UNCONDITIONAL on any settings write to an existing row: it is the increment
// (not the caller's expectedVersion) that makes a concurrent stale writer's CAS
// miss. expectedVersion only gates the 409 conflict check — a client that
// supplies it opts into failing fast, but omitting it must never silently bypass
// the clock. The create path is guarded by the organizationId unique constraint.
async function enforceSsoVersionLock(
  tx: Tx,
  orgId: string,
  existing: SsoSettingsRow,
  expectedVersion: number | undefined,
): Promise<void> {
  const cas = await tx.organizationSSOSettings.updateMany({
    where: {
      organizationId: orgId,
      ...(expectedVersion !== undefined && { version: expectedVersion }),
    },
    data: { version: { increment: 1 } },
  });
  if (cas.count === 0) {
    throw Object.assign(
      new Error(
        "SSO settings were changed in another session — reload and retry",
      ),
      {
        httpStatus: 409,
        code: "VERSION_CONFLICT",
        currentVersion: existing.version,
      },
    );
  }
}

// Enforcing SSO without at least one allowed domain OR an SSO provider would
// lock every user out of the org. Catch it here.
async function assertEnforceSsoIsSafe(
  tx: Tx,
  orgId: string,
  body: PatchBody,
  existing: SsoSettingsRow | null,
): Promise<void> {
  if (body.enforceSSO !== true) return;
  const effectiveDomains =
    body.allowedEmailDomains ?? existing?.allowedEmailDomains ?? [];
  const providerCount = await tx.ssoProvider.count({
    where: { organizationId: orgId },
  });
  if (effectiveDomains.length === 0 && providerCount === 0) {
    throw Object.assign(
      new Error(
        "Cannot enforce SSO without at least one allowed domain or SSO provider configured.",
      ),
      { httpStatus: 409 },
    );
  }
}

// PR-1d / #675: SSO settings (the high-impact ones — enforcement + auto-join)
// require a verified domain. Without this gate any org could enforce SSO against
// an unverified domain and lock out members of a third-party org that happens to
// share the email suffix.
async function assertSensitiveChangeVerified(
  tx: Tx,
  orgId: string,
  body: PatchBody,
): Promise<void> {
  const sensitiveChange =
    body.enforceSSO === true ||
    (body.allowedEmailDomains !== undefined &&
      body.allowedEmailDomains.length > 0);
  if (sensitiveChange && !(await hasVerifiedDomain(tx, orgId))) {
    throw new DomainVerificationRequiredError("SSO");
  }
}

function upsertSsoSettings(
  tx: Tx,
  orgId: string,
  body: PatchBody,
) {
  return tx.organizationSSOSettings.upsert({
    where: { organizationId: orgId },
    create: {
      organizationId: orgId,
      allowedEmailDomains: body.allowedEmailDomains ?? [],
      enforceSSO: body.enforceSSO ?? false,
      defaultRoleForAutoJoin: body.defaultRoleForAutoJoin ?? "LEARNER",
    },
    update: {
      ...(body.allowedEmailDomains !== undefined && {
        allowedEmailDomains: body.allowedEmailDomains,
      }),
      ...(body.enforceSSO !== undefined && { enforceSSO: body.enforceSSO }),
      ...(body.defaultRoleForAutoJoin !== undefined && {
        defaultRoleForAutoJoin: body.defaultRoleForAutoJoin,
      }),
    },
  });
}

// SSO_ENABLED/DISABLED specifically fires on enforceSSO flips, not generic
// setting edits. Domain list changes still count as SETTINGS_CHANGED.
function resolveSsoAuditAction(existing: SsoSettingsRow | null, body: PatchBody) {
  const ssoStateChanged =
    body.enforceSSO !== undefined &&
    body.enforceSSO !== (existing?.enforceSSO ?? false);
  if (!ssoStateChanged) return AUDIT_ACTIONS.SETTINGS.SETTINGS_CHANGED;
  return body.enforceSSO
    ? AUDIT_ACTIONS.SETTINGS.SSO_ENABLED
    : AUDIT_ACTIONS.SETTINGS.SSO_DISABLED;
}

async function writeSsoAuditLog(
  tx: Tx,
  params: {
    orgId: string;
    actorMembershipId: string;
    existing: SsoSettingsRow | null;
    next: SsoSettingsRow;
    body: PatchBody;
  },
): Promise<void> {
  const { orgId, actorMembershipId, existing, next, body } = params;
  await tx.orgAuditLog.create({
    data: {
      organizationId: orgId,
      actorMembershipId,
      category: "SETTINGS",
      action: resolveSsoAuditAction(existing, body),
      description: "SSO settings updated",
      details: {
        from: {
          allowedEmailDomains: existing?.allowedEmailDomains ?? [],
          enforceSSO: existing?.enforceSSO ?? false,
          defaultRoleForAutoJoin:
            existing?.defaultRoleForAutoJoin ?? "LEARNER",
        },
        to: {
          allowedEmailDomains: next.allowedEmailDomains,
          enforceSSO: next.enforceSSO,
          defaultRoleForAutoJoin: next.defaultRoleForAutoJoin,
        },
      },
    },
  });
}

// Maps known/expected errors to their JSON response; returns null for
// unexpected errors so the caller can capture + rethrow.
function buildKnownSsoErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof DomainVerificationRequiredError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.httpStatus },
    );
  }
  if (err instanceof Error && "httpStatus" in err) {
    const status =
      typeof err.httpStatus === "number" ? err.httpStatus : 500;
    // VERSION_CONFLICT carries currentVersion so the client can
    // refetch-and-retry without an extra GET.
    const code =
      "code" in err && typeof err.code === "string" ? err.code : undefined;
    const currentVersion =
      "currentVersion" in err && typeof err.currentVersion === "number"
        ? err.currentVersion
        : undefined;
    return NextResponse.json(
      {
        error: err.message,
        ...(code && { code }),
        ...(currentVersion !== undefined && { currentVersion }),
      },
      { status },
    );
  }
  return null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  const [settings, providers, claims] = await Promise.all([
    prisma.organizationSSOSettings.findUnique({
      where: { organizationId: orgId },
    }),
    prisma.ssoProvider.findMany({
      where: { organizationId: orgId },
      select: {
        id: true,
        providerId: true,
        issuer: true,
        domain: true,
        samlConfig: true,
        oidcConfig: true,
      },
    }),
    prisma.orgDomainClaim.findMany({
      where: { organizationId: orgId },
      select: { id: true, domain: true, claimedAt: true },
    }),
  ]);

  return NextResponse.json({
    settings: settings ?? {
      organizationId: orgId,
      allowedEmailDomains: [],
      enforceSSO: false,
      defaultRoleForAutoJoin: "LEARNER",
      version: 1,
    },
    providers: providers.map(({ samlConfig, oidcConfig, ...rest }) => ({
      ...rest,
      providerType: samlConfig ? "saml" : oidcConfig ? "oidc" : null,
    })),
    domainClaims: claims,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.organizationSSOSettings.findUnique({
        where: { organizationId: orgId },
      });

      if (existing) {
        await enforceSsoVersionLock(tx, orgId, existing, body.expectedVersion);
      }
      await assertEnforceSsoIsSafe(tx, orgId, body, existing);
      await assertSensitiveChangeVerified(tx, orgId, body);

      const next = await upsertSsoSettings(tx, orgId, body);
      await writeSsoAuditLog(tx, {
        orgId,
        actorMembershipId: access.member.id,
        existing,
        next,
        body,
      });

      return next;
    });

    return NextResponse.json({ settings: updated });
  } catch (err) {
    const known = buildKnownSsoErrorResponse(err);
    if (known) return known;
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "enterprise" } },
    );
    throw err;
  }
}
