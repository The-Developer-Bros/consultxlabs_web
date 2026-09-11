import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import {
  PROFILE_WITH_USER_SELECT,
  APPOINTMENT_LIST_SELECT,
} from "@/lib/booking/list-selects";
import { Prisma, AppointmentStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { transitionConsultationRequest } from "@/lib/booking/transitions";
import { refundRejectedRequest } from "@/lib/booking/rejection-refund";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import { resolveOrgScope, scopeOrgId } from "@/lib/api/scope/parse";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

export async function GET(request: NextRequest) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const { searchParams } = new URL(request.url);
    const consultantProfileId = searchParams.get("consultantProfileId");
    const consulteeProfileId = searchParams.get("consulteeProfileId");
    const status = searchParams.get("status") as AppointmentStatus | null;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");

    const whereClause: Record<string, unknown> = {};

    // Authorization: filter by ownership for non-privileged users.
    // #org-appts — profile ids are carried independently of the singular
    // platform role. An explicit ?consultant/consulteeProfileId= (from a
    // consultant/consultee dashboard) narrows to THAT side — validated against
    // the session so a caller can only request their OWN profile. With no
    // filter, union whichever profiles the session carries, so a dual-profile
    // user sees both sides; a single-identity user matches one arm. Nested under
    // AND so it composes with the orgScope OR below instead of clobbering it.
    if (!isPrivileged(session.user.role)) {
      const ownershipArms: Prisma.ConsultationWhereInput[] = [];
      if (consultantProfileId) {
        if (consultantProfileId !== session.user.consultantProfileId) {
          return forbiddenResponse("Access denied");
        }
        ownershipArms.push({ consultationPlan: { consultantProfileId } });
      }
      if (consulteeProfileId) {
        if (consulteeProfileId !== session.user.consulteeProfileId) {
          return forbiddenResponse("Access denied");
        }
        ownershipArms.push({ requestedById: consulteeProfileId });
      }
      if (ownershipArms.length === 0) {
        // No explicit side → union whichever profiles the session carries.
        if (session.user.consultantProfileId) {
          ownershipArms.push({
            consultationPlan: {
              consultantProfileId: session.user.consultantProfileId,
            },
          });
        }
        if (session.user.consulteeProfileId) {
          ownershipArms.push({
            requestedById: session.user.consulteeProfileId,
          });
        }
      }
      if (ownershipArms.length === 0) {
        // No profile of either kind - deny access.
        return forbiddenResponse("Access denied");
      }
      whereClause.AND = [{ OR: ownershipArms }];
    } else {
      // Privileged users can filter by any profile
      if (consultantProfileId) {
        whereClause.consultationPlan = {
          consultantProfile: {
            id: consultantProfileId,
          },
        };
      }

      if (consulteeProfileId) {
        whereClause.requestedById = consulteeProfileId;
      }
    }

    if (status) {
      whereClause.status = status;
    }

    // Personal-vs-org scope filter (same mechanism as /api/slots/appointments:
    // the denormalized Appointment.organizationId). #org-appts — an ABSENT param
    // now means PERSONAL/B2C (matching resolveOrgScope's documented default),
    // NOT the old unfiltered union: the personal dashboards dropped the org
    // switcher and must stay B2C. Org surfaces pass an explicit orgScope. A
    // consultation with no Appointment row is not org-funded → personal.
    const rawOrgScope = searchParams.get("orgScope");
    const explicitPersonal =
      rawOrgScope === "mine" || rawOrgScope === "personal";
    // Absent param defaults to personal for non-privileged callers (B2C
    // dashboards) but stays unfiltered for ADMIN/STAFF (they oversee all).
    const defaultPersonal = !rawOrgScope && !isPrivileged(session.user.role);
    if (explicitPersonal || defaultPersonal) {
      // Personal — no membership lookup needed.
      whereClause.OR = [
        { appointment: null },
        { appointment: { organizationId: null } },
      ];
    } else if (rawOrgScope) {
      // Explicit org / all (privileged + absent falls through → no filter).
      const memberships = await prisma.membership.findMany({
        where: { userId: session.user.id, status: "ACTIVE" },
        select: { organizationId: true, status: true, role: true },
      });
      const scopeResolution = resolveOrgScope({
        raw: rawOrgScope,
        memberships,
        userRole: session.user.role,
        userId: session.user.id,
        // Self-scoped: the ownership filter above already locks non-admin
        // callers to their own rows, so "all" just means "all of MY data".
        allowAllForOwner: true,
      });
      if (!scopeResolution.ok) {
        return NextResponse.json(
          { error: scopeResolution.message, code: scopeResolution.code },
          { status: scopeResolution.status },
        );
      }
      // #674 B2B gap 9 — `orgMember` pins an org too: it is what an active
      // member below `operations.read` resolves to, meaning "my own rows in
      // THAT org". Testing `kind === "org"` alone dropped them into the
      // unfiltered arm, so picking one org returned every org plus personal.
      // scopeOrgId is the single place that knows which kinds pin.
      const pinnedOrgId = scopeOrgId(scopeResolution.scope);
      if (pinnedOrgId) {
        whereClause.appointment = { organizationId: pinnedOrgId };
      }
      // kind === "all": no additional filter
    }

    const [consultations, total] = await Promise.all([
      // #997 Phase 0 — narrow SELECT (see subscriptions route for rationale).
      prisma.consultation.findMany({
        where: whereClause,
        select: {
          id: true,
          status: true,
          requestedAt: true,
          bookingSource: true,
          // What the consultee actually said. The Requests table had a wide
          // empty column and no way to see it, so the consultant allocated
          // times without ever reading the one thing explaining the request.
          requestNotes: true,
          consultationPlan: {
            select: {
              id: true,
              title: true,
              durationInHours: true,
              consultantProfileId: true,
              consultantProfile: PROFILE_WITH_USER_SELECT,
            },
          },
          requestedBy: PROFILE_WITH_USER_SELECT,
          appointment: APPOINTMENT_LIST_SELECT,
        },
        orderBy: {
          requestedAt: "desc",
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.consultation.count({ where: whereClause }),
    ]);

    return NextResponse.json({
      data: consultations,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("Error fetching consultations:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching consultations" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    // #831 — event mutations previously had no limiter
    const rl = await applyRateLimit(eventMutationLimiter, session.user.id);
    if (rl) return rl;

    const body = await request.json();
    const { id, status } = body;

    if (!id || !status) {
      return NextResponse.json(
        { error: "ID and status are required" },
        { status: 400 },
      );
    }

    if (
      !Object.values(AppointmentStatus).includes(status as AppointmentStatus)
    ) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }

    // Verify ownership before allowing status change
    const existingConsultation = await prisma.consultation.findUnique({
      where: { id },
      include: {
        consultationPlan: {
          include: {
            consultantProfile: true,
          },
        },
      },
    });

    if (!existingConsultation) {
      return NextResponse.json(
        { error: "Consultation not found" },
        { status: 404 },
      );
    }

    // Check authorization: must be a participant or privileged
    const isConsultant =
      !!existingConsultation.consultationPlan?.consultantProfile?.id &&
      existingConsultation.consultationPlan.consultantProfile.id ===
        session.user.consultantProfileId;
    const isConsultee =
      !!existingConsultation.requestedById &&
      existingConsultation.requestedById === session.user.consulteeProfileId;
    const isParticipant = isConsultant || isConsultee;

    if (!isPrivileged(session.user.role) && !isParticipant) {
      return forbiddenResponse(
        "You can only update consultations you are a participant in",
      );
    }

    // #1004 — declining is the CONSULTANT's act. REJECTED is legal from
    // PENDING and APPROVED_PENDING_PAYMENT, so without this guard a consultee
    // could reject their own PAID direct-checkout booking and ride the
    // consultant-initiated 100% refund tier on demand. Mirrors the hardened
    // [consultationId] PATCH route.
    if (
      status === AppointmentStatus.REJECTED &&
      !isConsultant &&
      !isPrivileged(session.user.role)
    ) {
      return forbiddenResponse(
        "Only the consultant can decline a request. Cancel it instead.",
      );
    }

    // #836 — allowed-from guard rides the WHERE; updateMany returns no row,
    // so re-read for the heavy include.
    await prisma.$transaction((tx) =>
      transitionConsultationRequest(tx, { where: { id }, to: status }),
    );

    // #1004 — a rejected request that was already paid has to give the money
    // back. Direct checkout captures BEFORE the request exists, so a
    // consultant declining a paid booking is the buyer's only exit; the
    // transition's allowed-from guard makes this at-most-once. Never throws
    // (failures surface in Sentry + system events).
    const rejectionRefund =
      status === AppointmentStatus.REJECTED
        ? await refundRejectedRequest({
            kind: "consultation",
            requestId: id,
            initiatedByUserId: session.user.id,
            actor: isConsultant ? "CONSULTANT" : "PLATFORM",
          })
        : null;

    const consultation = await prisma.consultation.findUniqueOrThrow({
      where: { id },
      include: {
        consultationPlan: {
          include: {
            consultantProfile: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                    role: true,
                    phone: true,
                  },
                },
              },
            },
          },
        },
        requestedBy: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                role: true,
                phone: true,
              },
            },
          },
        },
        appointment: {
          include: {
            slotsOfAppointment: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                    role: true,
                    phone: true,
                  },
                },
              },
            },
            payment: {
              select: {
                id: true,
                paymentStatus: true,
                amount: true,
                currency: true,
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: consultation, rejectionRefund });
  } catch (error) {
    if (error instanceof IllegalTransitionError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("Error updating consultation:", error);
    return NextResponse.json(
      { error: "An error occurred while updating consultation" },
      { status: 500 },
    );
  }
}
