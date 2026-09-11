import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import {
  PROFILE_WITH_USER_SELECT,
  APPOINTMENT_LIST_SELECT,
} from "@/lib/booking/list-selects";
import { Prisma, AppointmentStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { addMonths } from "date-fns";
import {
  notifySubscriptionStarted,
  notifySubscriptionCancelled,
} from "@/lib/novu";
import { logSubscriptionCancelled } from "@/lib/activity/log-activity";
import { UpdateSubscriptionStatusSchema } from "@/schemas/subscriptions";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { transitionSubscriptionRequest } from "@/lib/booking/transitions";
import { refundRejectedRequest } from "@/lib/booking/rejection-refund";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import { resolveOrgScope, scopeOrgId } from "@/lib/api/scope/parse";

export async function GET(request: NextRequest) {
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

  try {
    const whereClause: Prisma.SubscriptionWhereInput = {};

    // Authorization: filter by ownership for non-privileged users.
    // #org-appts — profile ids are carried independently of the singular
    // platform role. An explicit ?consultant/consulteeProfileId= narrows to THAT
    // side — validated against the session so a caller can only request their
    // OWN profile. With no filter, union whichever profiles the session carries,
    // so a dual-profile user sees both sides; a single-identity user matches one
    // arm. Nested under AND so it composes with the orgScope filter below.
    if (!isPrivileged(session.user.role)) {
      const ownershipArms: Prisma.SubscriptionWhereInput[] = [];
      if (consultantProfileId) {
        if (consultantProfileId !== session.user.consultantProfileId) {
          return forbiddenResponse("Access denied");
        }
        ownershipArms.push({ subscriptionPlan: { consultantProfileId } });
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
            subscriptionPlan: {
              consultantProfileId: session.user.consultantProfileId,
            },
          });
        }
        if (session.user.consulteeProfileId) {
          ownershipArms.push({ requestedById: session.user.consulteeProfileId });
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
        whereClause.subscriptionPlan = {
          consultantProfileId,
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
    // the denormalized Appointment.organizationId, here through the
    // subscription's to-many `appointments`). #org-appts — an ABSENT param now
    // means PERSONAL/B2C (matching resolveOrgScope's default), NOT the old
    // union: the personal dashboards dropped the org switcher and must stay B2C.
    // A subscription whose appointments carry no org stamp — including one with
    // zero appointment rows — is personal.
    const rawOrgScope = searchParams.get("orgScope");
    const explicitPersonal =
      rawOrgScope === "mine" || rawOrgScope === "personal";
    // Absent param defaults to personal for non-privileged callers (B2C
    // dashboards) but stays unfiltered for ADMIN/STAFF (they oversee all).
    const defaultPersonal = !rawOrgScope && !isPrivileged(session.user.role);
    if (explicitPersonal || defaultPersonal) {
      // Personal — no membership lookup needed.
      // #997 — composite index rides #1169 PR 9 (#1176). This anti-join is the
      // PENDING list's remaining server cost: `none` compiles to a correlated
      // NOT EXISTS that `@@index([subscriptionId])` can seek but not cover, so
      // every candidate subscription pays a heap fetch to read organizationId.
      // No Prisma shape is cheaper — `every: { organizationId: null }` is the
      // same subquery with an extra negation — so the fix is the index, not
      // the query.
      whereClause.appointments = {
        none: { organizationId: { not: null } },
      };
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
      // `orgMember` pins an org exactly as `org` does — see scopeOrgId.
      const scopedOrgId = scopeOrgId(scopeResolution.scope);
      if (scopedOrgId) {
        whereClause.appointments = {
          some: { organizationId: scopedOrgId },
        };
      }
      // kind === "all": no additional filter
    }

    // #997 Phase 0 — narrow SELECTs replace the old include tree. The deep
    // includes joined consultantProfile.domain/subDomains/tags (M2M) and a
    // per-slot user M2M that no list consumer reads, and over-shared user
    // PII (email/role/phone) against the #946 allowlist direction. Field
    // superset verified across RequestSlotAllocationTab, the Mini tab,
    // fetchApprovals, and useEvents consumers.
    const [subscriptions, total] = await Promise.all([
      prisma.subscription.findMany({
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
          schedulingPeriodStartsAt: true,
          schedulingPeriodEndsAt: true,
          schedulingTimezone: true,
          subscriptionPlan: {
            select: {
              id: true,
              title: true,
              sessionsPerWeek: true,
              durationInMonths: true,
              sessionDurationInHours: true,
              totalSessions: true,
              consultantProfileId: true,
              consultantProfile: PROFILE_WITH_USER_SELECT,
            },
          },
          requestedBy: PROFILE_WITH_USER_SELECT,
          appointments: APPOINTMENT_LIST_SELECT,
        },
        orderBy: {
          requestedAt: "desc",
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.subscription.count({ where: whereClause }),
    ]);

    return NextResponse.json({
      data: subscriptions,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    console.error("Error fetching subscriptions:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching subscriptions" },
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
    const result = UpdateSubscriptionStatusSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }
    const { id, status } = result.data;

    // First fetch the subscription to validate it exists and get all necessary data
    const existingSubscription = await prisma.subscription.findUnique({
      where: { id },
      include: {
        subscriptionPlan: {
          include: {
            consultantProfile: {
              include: {
                user: { select: { id: true, name: true, email: true, image: true, role: true, phone: true } },
              },
            },
          },
        },
        requestedBy: {
          include: {
            user: { select: { id: true, name: true, email: true, image: true, role: true, phone: true } },
          },
        },
      },
    });

    if (!existingSubscription) {
      return NextResponse.json(
        { error: "Subscription not found" },
        { status: 404 },
      );
    }

    if (!existingSubscription.subscriptionPlan?.consultantProfile?.user?.id) {
      return NextResponse.json(
        { error: "Invalid subscription: missing consultant information" },
        { status: 400 },
      );
    }

    if (!existingSubscription.requestedBy?.user?.id) {
      return NextResponse.json(
        { error: "Invalid subscription: missing requestedBy information" },
        { status: 400 },
      );
    }

    // Check authorization: must be a participant or privileged
    const isConsultant =
      !!existingSubscription.subscriptionPlan?.consultantProfile?.id &&
      existingSubscription.subscriptionPlan.consultantProfile.id ===
        session.user.consultantProfileId;
    const isConsultee =
      !!existingSubscription.requestedById &&
      existingSubscription.requestedById === session.user.consulteeProfileId;
    if (!isPrivileged(session.user.role) && !isConsultant && !isConsultee) {
      return forbiddenResponse(
        "You can only modify subscriptions you are a participant in",
      );
    }

    // #1004 — declining is the CONSULTANT's act. REJECTED is legal from
    // PENDING and APPROVED_PENDING_PAYMENT, so without this guard a consultee
    // could reject their own PAID booking and ride the consultant-initiated
    // 100% refund tier on demand. Mirrors the consultations list PATCH.
    if (
      status === AppointmentStatus.REJECTED &&
      !isConsultant &&
      !isPrivileged(session.user.role)
    ) {
      return forbiddenResponse(
        "Only the consultant can decline a request. Cancel it instead.",
      );
    }

    const startDate = new Date();
    const endDate = addMonths(
      startDate,
      existingSubscription.subscriptionPlan.durationInMonths,
    );

    try {
      // #836 — allowed-from guard rides the WHERE; updateMany returns no
      // row, so re-read for the heavy include.
      await prisma.$transaction((tx) =>
        transitionSubscriptionRequest(tx, {
          where: { id },
          to: status,
          data: {
            schedulingPeriodStartsAt: startDate,
            schedulingPeriodEndsAt: endDate,
          },
        }),
      );

      // #1004 — rejection refund through the front door, after commit.
      const rejectionRefund =
        status === AppointmentStatus.REJECTED
          ? await refundRejectedRequest({
              kind: "subscription",
              requestId: id,
              initiatedByUserId: session.user.id,
              actor: isConsultant ? "CONSULTANT" : "PLATFORM",
            })
          : null;

      const subscription = await prisma.subscription.findUniqueOrThrow({
        where: { id },
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: { select: { id: true, name: true, email: true, image: true, role: true, phone: true } },
                },
              },
            },
          },
          requestedBy: {
            include: {
              user: { select: { id: true, name: true, email: true, image: true, role: true, phone: true } },
            },
          },
          appointments: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: { select: { id: true, name: true, email: true, image: true, role: true, phone: true } },
                },
              },
              payment: { select: { id: true, paymentStatus: true, amount: true, currency: true } },
            },
          },
        },
      });

      // If approved, notify consultee
      // Note: Appointment slots are created through SlotAllocationService during checkout,
      // not here. This handler only manages status transitions and notifications.
      if (status === AppointmentStatus.APPROVED) {
        // Fire-and-forget: notify consultee that subscription started
        const consulteeUserId = subscription.requestedBy?.user?.id;
        if (consulteeUserId) {
          void notifySubscriptionStarted(consulteeUserId, {
            subscriptionId: subscription.id,
            planTitle: subscription.subscriptionPlan?.title || "Subscription",
            consultantName:
              subscription.subscriptionPlan?.consultantProfile?.user?.name ||
              "Consultant",
            consulteeName: subscription.requestedBy?.user?.name || undefined,
            dashboardUrl: "/dashboard",
          });
        }
      }

      // Fire-and-forget: notify both parties on cancellation
      if (status === AppointmentStatus.CANCELLED) {
        const consultantUserId =
          subscription.subscriptionPlan?.consultantProfile?.user?.id;
        const consulteeUserId = subscription.requestedBy?.user?.id;
        const userIds = [consultantUserId, consulteeUserId].filter(
          (id): id is string => !!id,
        );
        if (userIds.length > 0) {
          void notifySubscriptionCancelled(userIds, {
            subscriptionId: subscription.id,
            planTitle: subscription.subscriptionPlan?.title || "Subscription",
            consultantName:
              subscription.subscriptionPlan?.consultantProfile?.user?.name ||
              "Consultant",
            consulteeName: subscription.requestedBy?.user?.name || undefined,
            dashboardUrl: "/dashboard",
          });
        }

        // Log cancellation activity (awaited — DB write should not be dropped in serverless)
        const cpId = subscription.subscriptionPlan?.consultantProfileId;
        if (cpId) {
          await logSubscriptionCancelled(
            cpId,
            subscription.id,
            {
              id: session.user.id,
              name: session.user.name || "User",
              image: session.user.image,
            },
            subscription.subscriptionPlan?.title || "Subscription",
            session.user.id === consultantUserId ? "consultant" : "consultee",
          );
        }
      }

      return NextResponse.json({ data: subscription, rejectionRefund });
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
      console.error(
        "Transaction error:",
        error instanceof Error ? error.message : "Unknown error",
      );
      throw error;
    }
  } catch (error) {
    if (error instanceof IllegalTransitionError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    console.error(
      "Error updating subscription:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return NextResponse.json(
      { error: "An error occurred while updating subscription" },
      { status: 500 },
    );
  }
}
