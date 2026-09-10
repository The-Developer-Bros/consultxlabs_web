/**
 * Consultant Tax Info API
 * Manage PAN, GSTIN, and other tax-related info for consultants
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { z } from "zod";
import { encryptPAN } from "@/lib/payments/tax/pan-crypto";
import { isValidUdyamNumber } from "@/lib/compliance/msme";

const updateTaxInfoSchema = z.object({
  panNumber: z.string().length(10).optional(),
  gstin: z.string().length(15).optional(),
  country: z.string().length(2).optional(),
  // BLOCKER-0 resolution (#1230 / handoff): this nullable column is the
  // CANONICAL entity-type field — payout withholding reads it fail-closed
  // (null ⇒ no ₹5L exemption). Until a consultant declares it here, every
  // payout over-withholds rather than wrongly granting companies the
  // individual exemption.
  taxEntityType: z.enum(["INDIVIDUAL", "HUF", "PARTNERSHIP", "LLP", "COMPANY"]).optional(),
  // MSME declaration — #1230 intake writer. The payout deadline engine reads
  // msmeStatus/writtenAgreementWithFamiliarise on ConsultantProfile to stamp
  // mustPayByDate (MSMED 15/45-day terms + §16 interest exposure); nothing
  // wrote them before, so every consultant defaulted to NONE. Udyam format is
  // validated server-side (UDYAM-XX-00-0000000).
  msmeStatus: z.enum(["NONE", "MICRO", "SMALL", "MEDIUM"]).optional(),
  udyamNumber: z.string().max(19).nullable().optional(),
  msmeWrittenAgreement: z.boolean().optional(),
});

/**
 * GET /api/consultant/tax-info
 * Get the authenticated consultant's tax info
 */
// S3776 — PAN encryption extracted so PUT stays under the complexity budget.
function buildPanFields(panNumber: string | undefined):
  | { panEncrypted: Uint8Array<ArrayBuffer>; panLast4: string }
  | undefined {
  if (!panNumber) return undefined;
  const { encrypted, last4 } = encryptPAN(panNumber);
  return { panEncrypted: encrypted, panLast4: last4 };
}

type MsmeDeclaration = {
  msmeStatus?: "NONE" | "MICRO" | "SMALL" | "MEDIUM";
  udyamNumber?: string | null;
  msmeWrittenAgreement?: boolean;
};

// S3776 — MSME profile write extracted from the PUT handler.
async function applyMsmeDeclaration(
  consultantProfileId: string,
  validated: MsmeDeclaration,
): Promise<void> {
  const msmeProfileUpdate = {
    ...(validated.msmeStatus !== undefined && {
      msmeStatus: validated.msmeStatus,
    }),
    ...(validated.udyamNumber !== undefined && {
      udyamNumber: validated.udyamNumber,
    }),
    ...(validated.msmeWrittenAgreement !== undefined && {
      writtenAgreementWithFamiliarise: validated.msmeWrittenAgreement,
    }),
  };
  if (Object.keys(msmeProfileUpdate).length === 0) return;
  await prisma.consultantProfile.update({
    where: { id: consultantProfileId },
    data: msmeProfileUpdate,
  });
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      include: { taxInfo: true },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    const taxInfo = consultantProfile.taxInfo;
    return NextResponse.json({
      hasTaxInfo: !!taxInfo,
      panMasked: taxInfo?.panLast4 ? `XXXXXX${taxInfo.panLast4}` : null,
      panVerified: taxInfo?.panVerified ?? false,
      gstin: taxInfo?.gstin ?? null,
      gstinVerified: taxInfo?.gstinVerified ?? false,
      country: taxInfo?.country ?? "IN",
      isIndianResident: taxInfo?.isIndianResident ?? true,
      taxEntityType: taxInfo?.taxEntityType ?? null,
      msmeStatus: consultantProfile.msmeStatus,
      udyamNumber: consultantProfile.udyamNumber,
      msmeWrittenAgreement: consultantProfile.writtenAgreementWithFamiliarise,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "consultant" } });
    console.error("Tax info GET error:", error);
    return NextResponse.json(
      { error: "Failed to fetch tax info" },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/consultant/tax-info
 * Create or update the authenticated consultant's tax info
 */
export async function PUT(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    const body = await req.json();
    const validated = updateTaxInfoSchema.parse(body);

    // Udyam format gate — reject malformed numbers rather than storing junk
    // that the MSME deadline engine would treat as registered (§37(2)(g)
    // disallowance turns on this classification being real).
    if (
      validated.udyamNumber !== undefined &&
      validated.udyamNumber !== null &&
      !isValidUdyamNumber(validated.udyamNumber)
    ) {
      return NextResponse.json(
        { error: "Udyam number must match UDYAM-XX-00-0000000" },
        { status: 400 },
      );
    }

    const isIndianResident = (validated.country || "IN") === "IN";

    // Encrypt PAN if provided
    const panFields = buildPanFields(validated.panNumber);

    const taxInfo = await prisma.consultantTaxInfo.upsert({      where: { consultantProfileId: consultantProfile.id },
      create: {
        consultantProfileId: consultantProfile.id,
        panEncrypted: panFields?.panEncrypted ?? null,
        panLast4: panFields?.panLast4 ?? null,
        gstin: validated.gstin,
        country: validated.country || "IN",
        isIndianResident,
        ...(validated.taxEntityType !== undefined && {
          taxEntityType: validated.taxEntityType,
        }),
      },
      update: {
        ...(validated.panNumber !== undefined && {
          panEncrypted: panFields?.panEncrypted ?? null,
          panLast4: panFields?.panLast4 ?? null,
          panVerified: false, // Reset verification on change
        }),
        ...(validated.gstin !== undefined && {
          gstin: validated.gstin,
          gstinVerified: false,
        }),
        ...(validated.country !== undefined && {
          country: validated.country,
          isIndianResident,
        }),
        ...(validated.taxEntityType !== undefined && {
          taxEntityType: validated.taxEntityType,
        }),
      },
    });

    // MSME declaration rides the same PUT (#1230): these live on the
    // ConsultantProfile row itself, not the TaxInfo satellite.
    await applyMsmeDeclaration(consultantProfile.id, validated);

    // Echo the PERSISTED declaration, not the request body (CR #1234): a
    // taxEntityType-only PUT previously answered null for MSME fields that
    // were in fact set, and the agreement flag was never returned.
    const profileAfter = await prisma.consultantProfile.findUnique({
      where: { id: consultantProfile.id },
      select: {
        msmeStatus: true,
        udyamNumber: true,
        writtenAgreementWithFamiliarise: true,
      },
    });

    return NextResponse.json({
      message: "Tax info updated",
      panMasked: taxInfo.panLast4 ? `XXXXXX${taxInfo.panLast4}` : null,
      panVerified: taxInfo.panVerified,
      gstin: taxInfo.gstin,
      gstinVerified: taxInfo.gstinVerified,
      country: taxInfo.country,
      taxEntityType: taxInfo.taxEntityType ?? null,
      msmeStatus: profileAfter?.msmeStatus ?? null,
      udyamNumber: profileAfter?.udyamNumber ?? null,
      msmeWrittenAgreement: profileAfter?.writtenAgreementWithFamiliarise ?? false,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message ?? "Invalid input" },
        { status: 400 },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "consultant" } });
    console.error("Tax info PUT error:", error);
    return NextResponse.json(
      { error: "Failed to update tax info" },
      { status: 500 },
    );
  }
}
