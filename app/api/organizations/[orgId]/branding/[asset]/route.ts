/**
 * POST   /api/organizations/[orgId]/branding/[asset]
 * DELETE /api/organizations/[orgId]/branding/[asset]
 *
 * One file, two assets: `[asset]` is `"logo"` or `"banner"`. POST takes a
 * multipart `file`, uploads to the `organization-images` bucket via
 * `lib/supabase.ts` helpers, then writes the resulting public URL to
 * `Organization.logo` or `Organization.bannerImage` inside a Prisma
 * transaction that also emits an `OrgAuditLog` row (category `SETTINGS`,
 * action `SETTINGS_CHANGED`). DELETE removes the stored object and nulls
 * the column. OWNER-only on both verbs — branding is a settings surface.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  uploadOrganizationLogo,
  uploadOrganizationBanner,
  deleteOrganizationLogo,
  deleteOrganizationBanner,
  ALLOWED_ORG_BRANDING_IMAGE_TYPES,
  ORG_LOGO_MAX_SIZE,
  ORG_BANNER_MAX_SIZE,
} from "@/lib/supabase";

const AssetSchema = z.enum(["logo", "banner"]);
type Asset = z.infer<typeof AssetSchema>;

const ASSET_COLUMN: Record<Asset, "logo" | "bannerImage"> = {
  logo: "logo",
  banner: "bannerImage",
};

const ASSET_MAX_SIZE: Record<Asset, number> = {
  logo: ORG_LOGO_MAX_SIZE,
  banner: ORG_BANNER_MAX_SIZE,
};

function parseAsset(raw: string): Asset | null {
  const parsed = AssetSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function badAsset() {
  return NextResponse.json(
    { error: "Invalid asset — must be 'logo' or 'banner'" },
    { status: 400 },
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; asset: string }> },
) {
  const { orgId, asset: rawAsset } = await params;
  const asset = parseAsset(rawAsset);
  if (!asset) return badAsset();

  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data body with a 'file' field" },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "No file provided" },
      { status: 400 },
    );
  }

  if (!ALLOWED_ORG_BRANDING_IMAGE_TYPES.includes(file.type)) {
    return NextResponse.json(
      {
        error:
          "Invalid file type. Please upload a JPEG, PNG, WebP, or SVG image.",
      },
      { status: 400 },
    );
  }

  const maxSize = ASSET_MAX_SIZE[asset];
  if (file.size > maxSize) {
    const limitMb = Math.round(maxSize / (1024 * 1024));
    return NextResponse.json(
      { error: `File size exceeds ${limitMb}MB limit` },
      { status: 400 },
    );
  }

  const uploadResult =
    asset === "logo"
      ? await uploadOrganizationLogo({ organizationId: orgId, file })
      : await uploadOrganizationBanner({ organizationId: orgId, file });

  if (!uploadResult.success || !uploadResult.fileUrl) {
    return NextResponse.json(
      { error: uploadResult.error ?? "Upload failed" },
      { status: 500 },
    );
  }

  const column = ASSET_COLUMN[asset];
  const fileUrl = uploadResult.fileUrl;
  const storagePath = uploadResult.storagePath;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      // #768 — branding lives on OrgBrandingProfile (1:1 sibling).
      // Upsert so the first edit creates the row.
      const profile = await tx.orgBrandingProfile.upsert({
        where: { organizationId: orgId },
        create: { organizationId: orgId, [column]: fileUrl },
        update: { [column]: fileUrl },
        select: { logo: true, bannerImage: true },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SETTINGS",
          action: AUDIT_ACTIONS.SETTINGS.SETTINGS_CHANGED,
          description: `Organization ${asset} updated`,
          details: { asset, storagePath, fileUrl },
        },
      });

      return { id: orgId, logo: profile.logo, bannerImage: profile.bannerImage };
    });

    return NextResponse.json({ organization: updated });
  } catch (err) {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    console.error(`Failed to persist organization ${asset}:`, err);
    return NextResponse.json(
      { error: "Failed to update organization branding" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ orgId: string; asset: string }> },
) {
  const { orgId, asset: rawAsset } = await params;
  const asset = parseAsset(rawAsset);
  if (!asset) return badAsset();

  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const column = ASSET_COLUMN[asset];

  const current = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      brandingProfile: { select: { logo: true, bannerImage: true } },
    },
  });
  if (!current) {
    return NextResponse.json(
      { error: "Organization not found" },
      { status: 404 },
    );
  }

  if (!current.brandingProfile?.[column]) {
    return NextResponse.json({
      organization: current,
      message: `No ${asset} to delete`,
    });
  }

  // Storage delete first; the audit row + DB null happen in a single tx.
  // If storage deletion fails we still null the column so the UI doesn't
  // keep pointing at a URL that may have been partially purged. The
  // helpers log their own errors.
  const storageDeleted =
    asset === "logo"
      ? await deleteOrganizationLogo(orgId)
      : await deleteOrganizationBanner(orgId);
  if (!storageDeleted) {
    console.warn(
      `Storage delete for organization ${asset} (${orgId}) reported failure — continuing to null the column`,
    );
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const profile = await tx.orgBrandingProfile.update({
        where: { organizationId: orgId },
        data: { [column]: null },
        select: { logo: true, bannerImage: true },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SETTINGS",
          action: AUDIT_ACTIONS.SETTINGS.SETTINGS_CHANGED,
          description: `Organization ${asset} removed`,
          details: { asset, removed: true },
        },
      });

      return { id: orgId, logo: profile.logo, bannerImage: profile.bannerImage };
    });

    return NextResponse.json({ organization: updated });
  } catch (err) {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    console.error(`Failed to clear organization ${asset}:`, err);
    return NextResponse.json(
      { error: "Failed to update organization branding" },
      { status: 500 },
    );
  }
}
