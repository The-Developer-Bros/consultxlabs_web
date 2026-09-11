import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { resolveOrgScope, type Scope } from "@/lib/api/scope/parse";
import {
  readConsulteeEvents,
  ConsulteeProfileNotFoundError,
} from "@/lib/data/consultee-events-read";

/**
 * Personal "all my bookings" widget endpoint. Returns the union of 5
 * booking types (consultations, subscriptions, webinars, classes,
 * trials) flattened for the consultee dashboard. Pre-existing surface
 * — keep using this for the consultee's primary appointments view.
 *
 * NOT to be confused with `/api/appointments` (#674 / B1-hybrid),
 * which is the paginated scope-aware list used by the new org
 * dashboards. See `prompts/enterprise-test-prompt.md` §10 for the
 * tradeoff matrix.
 *
 * `?orgScope=<orgId|personal|all>` — added in B1-personal-retrofit so
 * the consultee dashboard can toggle between personal-only / a
 * specific org's bookings / everything (admin-only). Default is
 * `personal` for backwards compatibility (previous callers omit the
 * param and get the same data they always have, since pre-B1 every
 * row was implicitly personal). Cross-tenant scope guard fires here
 * just like in `/api/appointments` — the caller must be a member of
 * the requested org or hold ADMIN/STAFF.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ consulteeId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { consulteeId } = await params;

    if (
      !isPrivileged(session.user.role) &&
      session.user.consulteeProfileId !== consulteeId
    ) {
      return forbiddenResponse("You can only access your own events");
    }

    if (!consulteeId) {
      return NextResponse.json(
        { error: "Consultee ID is required" },
        { status: 400 },
      );
    }

    // Get the userId from the consultee profile to match slot membership
    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { id: consulteeId },
      select: { userId: true },
    });

    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    const userId = consulteeProfile.userId;

    // B1-personal-retrofit: parse + authorize ?orgScope=. Default
    // `personal` keeps every existing caller working without changes.
    const url = new URL(request.url);
    const callerMemberships = await prisma.membership.findMany({
      where: { userId, status: "ACTIVE" },
      select: { organizationId: true, status: true, role: true },
    });
    const scopeResolution = resolveOrgScope({
      raw: url.searchParams.get("orgScope"),
      memberships: callerMemberships,
      userRole: session.user.role,
      userId: session.user.id,
      // Self-scoped: route already rejects requests for someone else's
      // consulteeProfileId, so `?orgScope=all` here means "my personal
      // + every org I belong to" — safe for any role.
      allowAllForOwner: true,
    });
    if (!scopeResolution.ok) {
      return NextResponse.json(
        { error: scopeResolution.message, code: scopeResolution.code },
        { status: scopeResolution.status },
      );
    }
    const scope: Scope = scopeResolution.scope;

    // #890 — shared read; same fn the consultee home server page calls so
    // SSR hydration matches.
    const data = await readConsulteeEvents(consulteeId, scope);

    return NextResponse.json({
      data,
      success: true,
    });
  } catch (error) {
    if (error instanceof ConsulteeProfileNotFoundError) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "dashboard" } },
    );
    console.error("Error fetching consultee events:", error);
    return NextResponse.json(
      { error: "Failed to fetch consultee events" },
      { status: 500 },
    );
  }
}
