/**
 * GET /api/organizations/public
 *
 * Public (unauthenticated) listing of organizations that have opted in to
 * marketplace discovery via `Organization.isPublic = true`.
 *
 * Capability (canSponsor/canHost) is a filter here, not a precondition: gating
 * the listing on canHost made it structurally empty, because ENABLE_HOST_ORGS
 * blocks canHost from ever being set. An org appears here because its OWNER
 * opted in, and for no other reason.
 *
 * Query params (all optional, repeated params for multi-value filters):
 *   search      — matches name / description / industry, case-insensitive
 *   type        — OrgDirectoryType, repeatable
 *   industry    — exact industry, repeatable
 *   size        — OrgSizeBucket, repeatable
 *   capability  — host | sponsor | hybrid
 *   hasExperts  — "true" to only list orgs with ACTIVE EXPERT members
 *   sort        — nameAsc | nameDesc | expertsDesc | newest
 *   page        — 1-indexed, default 1
 *   limit       — default 24, max 50
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";

import { apiError } from "@/lib/errors";
import {
  getOrganisationsPage,
  ORGANISATIONS_PER_PAGE,
} from "@/lib/data/explore-organisations";
import { orgFiltersFromSearchParams } from "@/lib/explore/organisation-filters";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
    const limit = Math.min(
      Math.max(
        1,
        parseInt(searchParams.get("limit") || String(ORGANISATIONS_PER_PAGE)) ||
          ORGANISATIONS_PER_PAGE,
      ),
      50,
    );

    const filters = orgFiltersFromSearchParams(searchParams);
    const result = await getOrganisationsPage(filters, page, limit);

    return NextResponse.json(
      {
        data: result.items,
        meta: {
          total: result.total,
          page: result.page,
          limit,
          totalPages: result.totalPages,
        },
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "organizations" } },
    );
    return apiError({ tag: "[Organizations.Public.GET]", error });
  }
}
