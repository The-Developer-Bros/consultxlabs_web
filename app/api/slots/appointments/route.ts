import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { AppointmentsType } from "@prisma/client";
import { requireApiAuth, isPrivileged } from "@/lib/auth-helpers";
import { resolveOrgScope } from "@/lib/api/scope/parse";
import { getConsultantAppointments } from "@/lib/data/consultant-appointments";
import { computeWeeklyConfirmedCallCounts } from "@/lib/booking/weekly-call-counts";

export async function GET(request: NextRequest) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const { searchParams } = new URL(request.url);

  const type = searchParams.get("type")?.toUpperCase();
  const consultantProfileId = searchParams.get("consultantProfileId");
  const consulteeProfileId = searchParams.get("consulteeProfileId");
  const userId = searchParams.get("userId");

  // Get specific event IDs for filtering
  const webinarId = searchParams.get("webinarId");
  const classId = searchParams.get("classId");
  const consultationId = searchParams.get("consultationId");
  const subscriptionId = searchParams.get("subscriptionId");

  // Get status for each appointment type
  const consultationStatus = searchParams
    .get("consultationStatus")
    ?.toUpperCase();
  const subscriptionStatus = searchParams
    .get("subscriptionStatus")
    ?.toUpperCase();
  const webinarStatus = searchParams.get("webinarStatus")?.toUpperCase();
  const classStatus = searchParams.get("classStatus")?.toUpperCase();

  // Non-privileged users must scope to their own data
  if (!isPrivileged(session.user.role)) {
    const hasOwnFilter =
      (consultantProfileId &&
        consultantProfileId === session.user.consultantProfileId) ||
      (consulteeProfileId &&
        consulteeProfileId === session.user.consulteeProfileId) ||
      (userId && userId === session.user.id);
    if (!hasOwnFilter) {
      return NextResponse.json(
        { error: "Forbidden: must filter by your own profile" },
        { status: 403 },
      );
    }
  }

  // Validate appointment type
  if (
    type &&
    !Object.values(AppointmentsType).includes(type as AppointmentsType)
  ) {
    return NextResponse.json(
      { error: "Invalid appointment type" },
      { status: 400 },
    );
  }

  // Validate statuses — consultation/subscription use AppointmentStatus enum,
  // webinar/class use their own event lifecycle statuses
  const validRequestStatuses = [
    "PENDING",
    "APPROVED",
    "APPROVED_PENDING_PAYMENT",
    "SCHEDULED",
    "COMPLETED",
    "REJECTED",
    "CANCELLED",
    "EXPIRED",
  ];
  const validEventStatuses = [
    "SCHEDULED",
    "IN_PROGRESS",
    "COMPLETED",
    "CANCELLED",
  ];
  if (
    consultationStatus &&
    !validRequestStatuses.includes(consultationStatus)
  ) {
    return NextResponse.json(
      { error: "Invalid consultation status" },
      { status: 400 },
    );
  }
  if (
    subscriptionStatus &&
    !validRequestStatuses.includes(subscriptionStatus)
  ) {
    return NextResponse.json(
      { error: "Invalid subscription status" },
      { status: 400 },
    );
  }
  if (webinarStatus && !validEventStatuses.includes(webinarStatus)) {
    return NextResponse.json(
      { error: "Invalid webinar status" },
      { status: 400 },
    );
  }
  if (classStatus && !validEventStatuses.includes(classStatus)) {
    return NextResponse.json(
      { error: "Invalid class status" },
      { status: 400 },
    );
  }

  // #674 personal-vs-org scope filter. The leak this closes: a consultant
  // who hosts under Acme + Zeta would see appointments from both orgs in
  // a single "Appointments" tab regardless of which org context the
  // dashboard had selected. Filter via the denormalized
  // Appointment.organizationId column populated by the #674 backfill.
  const callerMembershipsForScope = await prisma.membership.findMany({
    where: { userId: session.user.id, status: "ACTIVE" },
    select: { organizationId: true, status: true, role: true },
  });
  const scopeResolution = resolveOrgScope({
    raw: searchParams.get("orgScope"),
    memberships: callerMembershipsForScope,
    userRole: session.user.role,
    userId: session.user.id,
    // Self-scoped: non-admin callers are already locked to their own
    // profileId via `hasOwnFilter` above, so `?orgScope=all` here just
    // means "all of MY data" — safe for any role.
    allowAllForOwner: true,
  });
  if (!scopeResolution.ok) {
    return NextResponse.json(
      { error: scopeResolution.message, code: scopeResolution.code },
      { status: scopeResolution.status },
    );
  }
  try {
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    const appointments = await getConsultantAppointments({
      type: type as AppointmentsType | undefined,
      consultantProfileId,
      consulteeProfileId,
      userId,
      statuses: {
        consultation: consultationStatus || undefined,
        subscription: subscriptionStatus || undefined,
        webinar: webinarStatus || undefined,
        class: classStatus || undefined,
      },
      startDate,
      endDate,
      eventIds: {
        webinarId,
        classId,
        consultationId,
        subscriptionId,
      },
      // #674 defect 13 / B2B gap 9 — the Scope goes down whole. The
      // hand-rolled projection this replaces tested only `kind === "org"`, so
      // an org member below `operations.read` (resolved to `orgMember`) fell
      // through to the empty filter and got every org's appointments plus
      // their personal ones — the opposite of picking one org.
      scope: scopeResolution.scope,
    });

    // #997 Phase 3 — opt-in aggregate, only computed when the caller scopes
    // to a single subscription and states its per-call slot count (both
    // already known client-side from the plan config — no extra DB read).
    const slotsPerCallParam = searchParams.get("slotsPerCall");
    const slotsPerCall = slotsPerCallParam
      ? parseInt(slotsPerCallParam, 10)
      : NaN;
    const weeklyConfirmedCallCounts =
      subscriptionId && Number.isFinite(slotsPerCall) && slotsPerCall > 0
        ? computeWeeklyConfirmedCallCounts(
            appointments,
            subscriptionId,
            slotsPerCall,
          )
        : undefined;

    return NextResponse.json({
      data: appointments,
      ...(weeklyConfirmedCallCounts ? { weeklyConfirmedCallCounts } : {}),
    });
  } catch (error) {
    console.error("Error fetching appointments:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching appointments" },
      { status: 500 },
    );
  }
}
