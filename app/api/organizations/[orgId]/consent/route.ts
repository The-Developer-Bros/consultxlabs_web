/**
 * GET  /api/organizations/[orgId]/consent
 * POST /api/organizations/[orgId]/consent
 *
 * DPDP (India) consent-artifact surface, scoped to an org. Consent records
 * live on the global `ConsentArtifact` table — the org scope here filters
 * to artifacts granted by members of this organization, which gives admins
 * a compliance-dashboard view without exposing other orgs' records.
 *
 * POST writes a tamper-evident consent row via `buildConsentArtifact`
 * (lib/compliance/dpdp.ts). The SHA-256 hash is real; the surrounding
 * consent-manager + notice-versioning workflow is documented in the dpdp
 * stub header.
 *
 * Retention: `auditRetainedUntil` = grantedAt + 7y per DPDP Rules (Nov
 * 2025). A daily cron sweeper (jobs/compliance/consent-retention-sweeper)
 * purges expired rows — this endpoint does NOT delete.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { buildConsentArtifact, withdrawConsent } from "@/lib/compliance/dpdp";
import {
  normalizePurposeCode,
  type PurposeCode,
} from "@/lib/compliance/purpose-codes";

// Schedule VIII of the Indian Constitution enumerates 22 languages.
// Plus English as the lingua franca for enterprise UIs. Accept ISO 639-1
// codes here; the language-label mapping lives client-side.
const LanguageSchema = z
  .string()
  .min(2)
  .max(10)
  .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, "ISO 639-1/2 language code required");

const CreateBodySchema = z.object({
  userId: z.string().min(1).max(128),
  purposeCodes: z.array(z.string().min(1).max(64)).min(1).max(20),
  language: LanguageSchema,
  consentManager: z.string().min(1).max(120).nullable().optional(),
  version: z.coerce.number().int().min(1),
});

const QuerySchema = z.object({
  userId: z.string().min(1).max(128).optional(),
  active: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "consent.read" });
  if (access.error) return access.error;

  const url = new URL(req.url);
  const parsedQuery = QuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsedQuery.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: parsedQuery.error.flatten() },
      { status: 400 },
    );
  }
  const q = parsedQuery.data;

  // Scope to this org via the user → memberships relation so Postgres
  // does the filter with a JOIN rather than pulling every member userId
  // into application memory and blasting them back as an `IN (...)` list.
  // When `q.userId` is set we still constrain via the same relational
  // filter so non-members return an empty list instead of leaking cross-
  // org records.
  const consents = await prisma.consentArtifact.findMany({
    where: {
      ...(q.userId && { userId: q.userId }),
      user: { memberships: { some: { organizationId: orgId } } },
      ...(q.active === "true" && { withdrawnAt: null }),
      ...(q.active === "false" && { withdrawnAt: { not: null } }),
    },
    orderBy: { grantedAt: "desc" },
    take: q.limit,
  });

  return NextResponse.json({ data: consents });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "consent.manage" });
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

  // Normalise to the single canonical taxonomy (lib/compliance/purpose-codes.ts)
  // before storage, so the fail-closed runtime gate and the dashboard never
  // diverge again. `normalizePurposeCode` returns undefined for codes that are
  // neither a legacy alias nor already canonical — reject the whole request
  // rather than silently storing/dropping them, so non-canonical strings can
  // never re-enter the taxonomy.
  const normalized = body.purposeCodes.map((c) => ({
    raw: c,
    code: normalizePurposeCode(c),
  }));
  const unknown = normalized.filter((n) => n.code === undefined).map((n) => n.raw);
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: "Unknown purpose code(s)", detail: { unknown } },
      { status: 400 },
    );
  }
  // Unknowns rejected above, so every `code` is a narrowed PurposeCode here.
  const purposeCodes = Array.from(
    new Set(normalized.map((n) => n.code as PurposeCode)),
  );

  // Cross-org check: caller must be recording consent for an actual
  // member of this org.
  const member = await prisma.membership.findUnique({
    where: {
      userId_organizationId: { userId: body.userId, organizationId: orgId },
    },
    select: { id: true },
  });
  if (!member) {
    return NextResponse.json(
      { error: "User is not a member of this organization" },
      { status: 404 },
    );
  }

  const draft = buildConsentArtifact({
    userId: body.userId,
    dataFiduciary: `org:${orgId}`,
    purposeCodes,
    language: body.language,
    consentManager: body.consentManager ?? null,
    version: body.version,
  });

  const [consent] = await prisma.$transaction([
    prisma.consentArtifact.create({ data: draft }),
    prisma.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        targetMembershipId: member.id,
        category: "CONSENT",
        action: AUDIT_ACTIONS.CONSENT.CONSENT_GRANTED,
        // PII hygiene (DPDP §8, §11): do NOT spell out the data
        // principal's userId in the description — audit-log descriptions
        // are surfaced in the admin UI and exported via CSV/SIEM, which
        // widens the blast radius for a PII leak. The targetMembershipId
        // column already connects this log back to the exact member, and
        // `details` is a structured JSON blob that auditors can pivot on
        // without splashing the id in free text.
        description: `Consent granted for member ${member.id}`,
        details: {
          membershipId: member.id,
          purposeCodes,
          language: body.language,
          version: body.version,
          hash: draft.hash,
        },
      },
    }),
  ]);

  return NextResponse.json({ consent }, { status: 201 });
}

/**
 * DELETE /api/organizations/[orgId]/consent?userId=<uuid>&purposeCode=<code>
 *
 * Stamps `withdrawnAt=now()` on the user's active ConsentArtifacts.
 *
 *  - Withdrawal is irreversible in our model: a subsequent "re-grant"
 *    goes through `POST` and produces a NEW artifact with a fresh hash.
 *    That keeps the chain-of-custody intact for DPDP auditors.
 *
 *  - `purposeCode` scopes the withdrawal to artifacts whose purpose-code
 *    list contains that value. Omit it to withdraw ALL active consents
 *    for the user (full DPDP §12 opt-out).
 *
 *  - Admins (MANAGER+) can trigger withdrawal on behalf of a member —
 *    this is the org-side of the data principal's right to withdraw.
 *    Self-service withdrawal from the user's own account settings goes
 *    through a different route (to be added) that requires the
 *    authenticated user to match `userId` rather than MANAGER access.
 */
const DeleteQuerySchema = z.object({
  userId: z.string().min(1).max(128),
  purposeCode: z.string().min(1).max(64).optional(),
});

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "consent.manage" });
  if (access.error) return access.error;

  const url = new URL(req.url);
  const parsed = DeleteQuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { userId } = parsed.data;
  // Normalise a legacy kebab-case scope to canonical so a withdrawal targets
  // the same code the gate/storage uses (e.g. third-party-sharing-with-stream
  // → STREAM_DATA_PROCESSING). An unknown code must 400 — NOT fall back to
  // undefined, which `withdrawConsent` reads as "withdraw ALL consents" and
  // would silently escalate a scoped request into a full opt-out.
  let purposeCode: PurposeCode | undefined;
  if (parsed.data.purposeCode) {
    purposeCode = normalizePurposeCode(parsed.data.purposeCode);
    if (purposeCode === undefined) {
      return NextResponse.json(
        { error: "Unknown purpose code", detail: { purposeCode: parsed.data.purposeCode } },
        { status: 400 },
      );
    }
  }

  // Cross-org guard: same logic as POST — only members of this org can
  // have their consent withdrawn through this endpoint.
  const member = await prisma.membership.findUnique({
    where: {
      userId_organizationId: { userId, organizationId: orgId },
    },
    select: { id: true },
  });
  if (!member) {
    return NextResponse.json(
      { error: "User is not a member of this organization" },
      { status: 404 },
    );
  }

  const { withdrawnCount } = await withdrawConsent({ userId, purposeCode });

  if (withdrawnCount > 0) {
    await prisma.orgAuditLog
      .create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          targetMembershipId: member.id,
          category: "CONSENT",
          action: AUDIT_ACTIONS.CONSENT.CONSENT_WITHDRAWN,
          // Same PII-hygiene rule as CONSENT_GRANTED: no raw userId
          // in the description; the membership FK is the pivot.
          description: purposeCode
            ? `Consent withdrawn (purpose=${purposeCode}) for member ${member.id}`
            : `All consents withdrawn for member ${member.id}`,
          details: {
            membershipId: member.id,
            purposeCode: purposeCode ?? null,
            withdrawnCount,
          },
        },
      })
      .catch((err) => {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
        console.error("[consent DELETE] audit write failed", err);
      });
  }

  return NextResponse.json({ withdrawnCount });
}
