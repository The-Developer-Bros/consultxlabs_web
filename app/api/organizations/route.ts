/**
 * GET  /api/organizations
 * POST /api/organizations
 *
 * GET returns the orgs the caller is a member of — the list behind the
 * "your organizations" switcher in the UI. Each entry carries the light
 * fields the switcher needs (capability booleans, fundingSource, role).
 *
 * POST creates a new Organization + BillingAccount + OWNER Membership in
 * a single transaction. The caller is the OWNER of the created org; a
 * matching BetterAuth `Member` row is also written (so the org-scope
 * session gets populated on the next login).
 *
 * Invariants:
 *  - slug is unique and lower-cased;
 *  - at least one capability must be true (canSponsor OR canHost);
 *  - canSponsor=true → BillingAccount created with the chosen fundingSource.
 */

import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { getOperatorOrganizations } from "@/lib/data/org-workspace";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { isValidGstin } from "@/lib/compliance/gst";
import { isValidPan } from "@/lib/compliance/tds";
import { encryptPAN } from "@/lib/payments/tax/pan-crypto";
import { ENABLE_HOST_ORGS } from "@/lib/feature-flags";

// PROJECT is reserved in the Prisma enum for the v2 milestone workflow
// (scoped project-billing engine), but not accepted at the API boundary
// yet — callers that pick it would otherwise silently fall into the
// TAG_ONLY path in checkout. Re-add here once checkout has a dedicated
// PROJECT branch.
const FundingSourceSchema = z.enum([
  "PERSONAL",
  "LICENSE",
  "WALLET",
  "INVOICE",
]);
// #1396 — the `Currency` enum stays on the column (ADR 15 keeps the type), but
// this API refuses to write anything except INR. `BillingAccount.currency` is
// forwarded verbatim into `createRazorpayOrder` by the wallet top-up route, and
// every amount the platform stores is INR paise, so a USD account priced a
// ₹1,000 top-up as a $1,000 order.
const CurrencySchema = z.literal("INR");
const DataRegionSchema = z.enum(["IN", "US", "EU"]);
const SizeBucketSchema = z.enum([
  "SMALL_1_50",
  "MEDIUM_51_200",
  "LARGE_201_1000",
  "ENTERPRISE_1000_PLUS",
]);

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Carries an HTTP status (and optional machine-readable code) on a thrown
 * Error so the route's bottom-of-handler catch can serialise it without
 * untagged-Error guesswork. Replaces the previous `Object.assign(new
 * Error(...), { httpStatus: 409 })` pattern, which forced every reader
 * of the catch to cast through `unknown` to pull the status back out.
 */
class HttpError extends Error {
  readonly httpStatus: number;
  readonly code?: string;

  constructor(message: string, httpStatus: number, code?: string) {
    super(message);
    this.name = "HttpError";
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

const CreateBodySchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(63)
      .regex(SLUG_REGEX, "slug must be lower-case alphanumeric with hyphens")
      .optional(),
    canSponsor: z.boolean().default(true),
    canHost: z.boolean().default(false),
    fundingSource: FundingSourceSchema.default("PERSONAL"),
    billingEmail: z.string().email(),
    currency: CurrencySchema.default("INR"),
    paymentTermsDays: z.coerce.number().int().min(0).max(180).optional(),
    description: z.string().max(5000).nullable().optional(),
    industry: z.string().max(120).nullable().optional(),
    website: z.string().url().nullable().optional(),
    sizeBucket: SizeBucketSchema.nullable().optional(),
    dataResidencyRegion: DataRegionSchema.default("IN"),
    // GSTIN / PAN: format-only validation here; live API verification
    // (NIC GST taxpayer search, sanctions screening) lands in PR-2.
    // Format validators reject the obvious "made up" values that the
    // book-everything-then-ghost fraud pattern (#687) relies on.
    gstin: z
      .string()
      .nullable()
      .optional()
      .refine(
        (v) => v === null || v === undefined || isValidGstin(v),
        { message: "INVALID_GSTIN_FORMAT" },
      ),
    pan: z
      .string()
      .nullable()
      .optional()
      .refine(
        (v) => v === null || v === undefined || isValidPan(v),
        { message: "INVALID_PAN_FORMAT" },
      ),
    requiresPO: z.boolean().default(false),
  })
  .refine((v) => v.canSponsor || v.canHost, {
    message: "At least one of canSponsor or canHost must be true",
  });

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export async function GET() {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;

  // Body extracted to lib/data/org-workspace so the workspace home page's
  // SSR prefetch reads through the same code path (no SSR/CSR drift).
  const result = await getOperatorOrganizations(auth.session.user.id);
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;

  // Only UserRole.ORG_WORKSPACE can create organizations. Platform ADMIN can
  // also seed orgs (used by fixtures and back-office tooling). CONSULTANT
  // and CONSULTEE are distinct user types — they join orgs via invitation,
  // they don't create them. Blocks UI-bypass attempts via direct API.
  const creatorRole = auth.session.user.role;
  if (creatorRole !== "ORG_WORKSPACE" && creatorRole !== "ADMIN") {
    return NextResponse.json(
      {
        error:
          "Only organization administrators can create organizations. Sign up with the Organization Owner role to continue.",
      },
      { status: 403 },
    );
  }

  const raw = await req.json().catch(() => null);
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const desiredSlug = body.slug ?? slugify(body.name);
  if (!SLUG_REGEX.test(desiredSlug)) {
    return NextResponse.json(
      { error: "Generated slug is invalid — pass `slug` explicitly." },
      { status: 400 },
    );
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const dupSlug = await tx.organization.findUnique({
        where: { slug: desiredSlug },
        select: { id: true },
      });
      if (dupSlug) {
        throw new HttpError(
          `Slug '${desiredSlug}' is already taken`,
          409,
          "SLUG_TAKEN",
        );
      }

      // Create the org first WITHOUT billingAccountId so we can then
      // create the BillingAccount (it needs ownerOrgId). Then patch
      // back the link.
      const orgTmpId = randomUUID();
      // Why we hard-gate canHost here rather than via a WIP banner:
      // the reviewer's feedback on PR #655 was "WIP banners are not
      // production gates". The host-side settlement is gated by
      // ENABLE_HOST_ORGS (lib/payments/payouts/earnings-service.ts:124);
      // without that flag flipped, accepting canHost would let the org
      // be created but its earnings flow would silently no-op. We
      // reject at the API boundary instead so an OWNER receives a
      // typed 400 rather than a half-functional org.
      if (body.canHost && !ENABLE_HOST_ORGS) {
        throw Object.assign(
          new Error(
            "Host-capable orgs are gated by ENABLE_HOST_ORGS. Contact ops to flip the flag for your tenant.",
          ),
          { httpStatus: 400, code: "HOST_ORGS_GATED" },
        );
      }
      const org = await tx.organization.create({
        data: {
          id: orgTmpId,
          name: body.name,
          slug: desiredSlug,
          canSponsor: body.canSponsor,
          canHost: body.canHost,
          dataResidencyRegion: body.dataResidencyRegion,
          contractCurrency: body.currency,
          reportingCurrency: body.currency,
          billingEmail: body.billingEmail,
          paymentTermsDays: body.paymentTermsDays ?? 60,
          // #768 — branding fields live on OrgBrandingProfile. Upserted
          // below in the same transaction when any branding column is set.
          ...(body.description || body.industry || body.website || body.sizeBucket
            ? {
                brandingProfile: {
                  create: {
                    description: body.description ?? null,
                    industry: body.industry ?? null,
                    website: body.website ?? null,
                    sizeBucket: body.sizeBucket ?? null,
                  },
                },
              }
            : {}),
          // #771 D10 — tax identity lives on the OrganizationTaxInfo satellite.
          taxInfo: {
            create: {
              gstin: body.gstin ?? null,
              // #768 — PAN stored encrypted (parity with ConsultantTaxInfo).
              ...(body.pan
                ? (() => {
                    const { encrypted, last4 } = encryptPAN(body.pan);
                    return { panEncrypted: encrypted, panLast4: last4 };
                  })()
                : {}),
            },
          },
          requiresPO: body.requiresPO,
          status: "PENDING_VERIFICATION",
        },
      });

      let billingAccountId: string | null = null;
      if (body.canSponsor) {
        const ba = await tx.billingAccount.create({
          data: {
            ownerOrgId: org.id,
            billingEmail: body.billingEmail,
            currency: body.currency,
            fundingSource: body.fundingSource,
            walletBalance: body.fundingSource === "WALLET" ? 0 : null,
          },
        });
        billingAccountId = ba.id;
        await tx.organization.update({
          where: { id: org.id },
          data: { billingAccountId: ba.id },
        });
      }

      // OWNER Membership + a matching BetterAuth Member for invitation
      // + org-scope session support. The Member row's id becomes the
      // betterAuthMemberId pointer on Membership so the bridge is live
      // from the moment the org exists.
      const betterAuthMember = await tx.member.create({
        data: {
          organizationId: org.id,
          userId: auth.session.user.id,
          role: "OWNER",
        },
      });
      const membership = await tx.membership.create({
        data: {
          userId: auth.session.user.id,
          organizationId: org.id,
          status: "ACTIVE",
          role: "OWNER",
          betterAuthMemberId: betterAuthMember.id,
        },
      });

      // Lazy-create the operator-side profile for this user. Idempotent
      // across the creator's 2nd+ org — they already have one
      // OrgWorkspaceProfile row pinned by `userId @unique`. The user.update
      // via updateMany keeps the call cheap when the link is already set.
      const orgWorkspace = await tx.orgWorkspaceProfile.upsert({
        where: { userId: auth.session.user.id },
        create: { userId: auth.session.user.id },
        update: {},
        select: { id: true },
      });
      await tx.user.updateMany({
        where: { id: auth.session.user.id, orgWorkspaceProfileId: null },
        data: { orgWorkspaceProfileId: orgWorkspace.id },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: org.id,
          actorMembershipId: membership.id,
          targetMembershipId: membership.id,
          category: "MEMBER",
          action: AUDIT_ACTIONS.MEMBER.MEMBER_ADDED,
          description: `Organization '${org.name}' created by OWNER`,
          details: {
            slug: org.slug,
            canSponsor: org.canSponsor,
            canHost: org.canHost,
            fundingSource: body.canSponsor ? body.fundingSource : null,
          },
        },
      });

      return {
        organization: org,
        billingAccountId,
        membership,
        orgWorkspaceProfileId: orgWorkspace.id,
      };
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    // Centralised error mapper. Every branch returns a structured envelope
    // so the wizard never falls through to its generic "Failed to create
    // organization" toast — which loses every byte of useful diagnostic
    // information and was the actual cause of the bug we're fixing here.
    //
    // Always log the unwrapped error so dev console / Sentry capture the
    // real stack trace; the response body intentionally redacts internals
    // in production.
    const userId = auth.session.user.id;
    console.error("POST /api/organizations failed", {
      userId,
      slug: desiredSlug,
      err,
    });

    // 1) Errors we tagged ourselves (slug-409 etc.).
    if (err instanceof HttpError) {
      return NextResponse.json(
        {
          error: err.message,
          ...(err.code ? { code: err.code } : {}),
        },
        { status: err.httpStatus },
      );
    }

    // 2) Prisma known request errors — map the common ones onto useful
    //    HTTP statuses so the client can branch (especially P2034, where
    //    a retry is the right answer).
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      switch (err.code) {
        case "P2002":
          return NextResponse.json(
            {
              error: "Conflict — a unique constraint was violated",
              code: "P2002",
              detail: { target: err.meta?.target ?? null },
            },
            { status: 409 },
          );
        case "P2003":
          return NextResponse.json(
            {
              error: "Database foreign-key violation",
              code: "P2003",
              detail: { field: err.meta?.field_name ?? null },
            },
            { status: 500 },
          );
        case "P2025":
          return NextResponse.json(
            {
              error: err.message,
              code: "P2025",
            },
            { status: 404 },
          );
        case "P2034":
          return NextResponse.json(
            {
              error: "Transaction conflict — please retry",
              code: "P2034",
            },
            { status: 503 },
          );
        default:
          return NextResponse.json(
            {
              error: "Database error",
              code: err.code,
              ...(process.env.NODE_ENV !== "production"
                ? { message: err.message }
                : {}),
            },
            { status: 500 },
          );
      }
    }

    // 3) Prisma client-side validation (wrong types, unknown columns).
    //    These mean *we* sent a malformed query — return 400 so the
    //    client sees a different bucket than a runtime DB error.
    if (err instanceof Prisma.PrismaClientValidationError) {
      return NextResponse.json(
        {
          error: "Invalid query for Prisma client",
          code: "PRISMA_VALIDATION",
          ...(process.env.NODE_ENV !== "production"
            ? { message: err.message }
            : {}),
        },
        { status: 400 },
      );
    }

    // 4) Genuine unknown — still return JSON so the client doesn't see an
    //    empty body. In production the message is suppressed.
    return NextResponse.json(
      {
        error: "Internal server error",
        code: "INTERNAL",
        ...(process.env.NODE_ENV !== "production"
          ? { message: err instanceof Error ? err.message : String(err) }
          : {}),
      },
      { status: 500 },
    );
  }
}
