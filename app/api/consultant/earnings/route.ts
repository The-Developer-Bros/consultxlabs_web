/**
 * Consultant Earnings API
 * View earnings summary and history
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { EarningStatus } from "@prisma/client";
import { getSession } from "@/lib/auth-server";
import { buildConsultantEarningsPayload } from "@/lib/data/consultant-earnings-analytics";
import { resolveOrgScope } from "@/lib/api/scope/parse";
import { ENABLE_LIVE_PAYOUTS } from "@/lib/feature-flags";

/**
 * GET /api/consultant/earnings
 * Get consultant's earnings summary and history
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get consultant profile
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    // Parse query parameters
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status") as EarningStatus | null;
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = parseInt(searchParams.get("offset") || "0");
    // Additive: ?includeMonthly=1 appends trailing-6-month buckets for the
    // analytics page. Absent param = response unchanged.
    const includeMonthly = searchParams.get("includeMonthly") === "1";

    // #org-appts (#1024) — personal Earnings view splits by org-ness.
    // Membership lookup is only needed to authorize a specific `orgId`
    // scope value; "mine"/"personal"/"all" never touch the membership
    // table.
    const rawOrgScope = searchParams.get("orgScope")?.trim();
    const needsMemberships =
      !!rawOrgScope && !["mine", "personal", "all"].includes(rawOrgScope);
    const callerMemberships = needsMemberships
      ? await prisma.membership.findMany({
          where: { userId: session.user.id, status: "ACTIVE" },
          select: { organizationId: true, status: true, role: true },
        })
      : [];
    const scopeResolution = resolveOrgScope({
      raw: rawOrgScope,
      memberships: callerMemberships,
      userRole: session.user.role,
      userId: session.user.id,
      // Self-scoped consultant endpoint — `?orgScope=all` just means
      // "everything I earned, personal + every org I belong to".
      allowAllForOwner: true,
    });
    if (!scopeResolution.ok) {
      return NextResponse.json(
        { error: scopeResolution.message, code: scopeResolution.code },
        { status: scopeResolution.status },
      );
    }
    const organizationId =
      scopeResolution.scope.kind === "personal"
        ? null
        : scopeResolution.scope.kind === "org" ||
            scopeResolution.scope.kind === "orgMember"
          ? scopeResolution.scope.orgId
          : undefined; // "all" → no filter (org-data isolation for org/orgMember)

    const payload = await buildConsultantEarningsPayload(consultantProfile.id, {
      status: status || undefined,
      limit,
      offset,
      includeMonthly,
      organizationId,
    });

    // #776 §B honesty flag, ported from the org payouts page. With
    // ENABLE_LIVE_PAYOUTS off, a BATCHED earning is reserved at the platform,
    // not in flight to a bank — and the earnings page's own tooltip said "cash
    // is on its way to your bank". The client needs the flag to tell the truth,
    // and it is server-only, so it rides the payload.
    return NextResponse.json({
      ...payload,
      livePayoutsEnabled: ENABLE_LIVE_PAYOUTS,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "consultant" } },
    );
    console.error("Error fetching earnings:", error);
    return NextResponse.json(
      { error: "Failed to fetch earnings" },
      { status: 500 },
    );
  }
}
