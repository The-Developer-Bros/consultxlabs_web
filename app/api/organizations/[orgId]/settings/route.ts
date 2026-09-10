/**
 * Organization settings — GET / PATCH alias of /api/organizations/[orgId].
 *
 * Kept as a separate route so the dashboard "settings" page has a stable URL
 * that doesn't tangle with the resource itself. The implementation is a thin
 * pass-through to the same Prisma logic.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  try {
    const access = await requireOrgAccess(orgId, { minimumRole: "LEARNER" });
    if (access.error) return access.error;

    // `profile` mirrors the Organization row — callers need the
    // capability booleans + paymentTermsDays + description/website/etc.
    // BillingAccount is included so the settings page can show the
    // funding source without a second round-trip. taxInfo (#777 §B)
    // hydrates the Tax & compliance section — non-secret fields only;
    // panEncrypted never leaves the server.
    const [organization, billingAccount, taxInfo, msmeInfo] = await Promise.all([
      prisma.organization.findUnique({
        where: { id: orgId },
        select: {
          id: true,
          name: true,
          slug: true,
          brandingProfile: { select: { logo: true } },
        },
      }),
      prisma.billingAccount.findFirst({
        where: { ownerOrgId: orgId },
        select: { fundingSource: true, currency: true, creditLimit: true },
      }),
      prisma.organizationTaxInfo.findUnique({
        where: { organizationId: orgId },
        select: {
          gstin: true,
          gstStateCode: true,
          gstRegStatus: true,
          panLast4: true,
        },
      }),
      // #1230 wave-4 — MSME declaration hydrates the settings card; the
      // payout-deadline engine reads the same satellite.
      prisma.organizationMsmeInfo.findUnique({
        where: { organizationId: orgId },
        select: {
          msmeStatus: true,
          msmeWrittenAgreementOnFile: true,
        },
      }),
    ]);

    return NextResponse.json({
      organization: organization
        ? {
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            logo: organization.brandingProfile?.logo ?? null,
          }
        : null,
      profile: {
        ...access.org,
        billingAccount,
        taxInfo,
        msmeInfo,
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "org_settings_fetch_failed",
        route: "GET /api/organizations/[orgId]/settings",
        orgId,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "organizations" } });
    return NextResponse.json(
      { error: "Failed to fetch settings" },
      { status: 500 },
    );
  }
}

// PATCH delegates to the resource route by re-exporting its handler.
export { PATCH } from "../route";
