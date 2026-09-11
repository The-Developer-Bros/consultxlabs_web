/**
 * Shared read for the staff appointments table. #890
 *
 * Single entry point behind GET /api/staff/appointments AND the staff
 * appointments server page's SSR prefetch, so the SSR-hydrated cache and the
 * client useQuery (queryKey ["staff-appointments", filters]) resolve identical
 * payloads — both paths funnel through here and can't drift. Auth stays at the
 * call site: the route runs requirePrivilegedAuth(); the prefetch runs under
 * the dashboard layout's gate.
 *
 * The query + display formatting moved here verbatim from the route. The ONLY
 * shape change vs. the old route is Date→ISO string on the per-row
 * scheduledAt / endsAt / createdAt fields, which is exactly what the route's
 * NextResponse.json did on the wire — so the payload is byte-identical, it's
 * just now also safe to dehydrate into the React Query cache.
 */

import prisma from "@/lib/prisma";
import { AppointmentsType, Prisma } from "@prisma/client";
import { toPlain } from "@/lib/data/serialize";
import type { Scope } from "@/lib/api/scope/parse";
import { scopeToWhereOrgId } from "@/lib/api/scope/parse";

type Participant = {
  id: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
} | null;

type AppointmentPayment = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  gateway: string;
} | null;

/** Group events stand in for a person in the staff list — "12 attendees". */
function attendeeLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export type StaffAppointment = {
  id: string;
  type: string;
  title: string;
  consultant: Participant;
  consultee: Participant;
  scheduledAt: string;
  endsAt?: string;
  duration: number;
  status: string;
  hasIssue: boolean;
  issueType: string | null;
  payment: AppointmentPayment;
  createdAt: string;
};

export type StaffAppointmentsPayload = {
  appointments: StaffAppointment[];
  counts: {
    all: number;
    issues: number;
    scheduled: number;
    completed: number;
  };
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasMore: boolean;
  };
};

export type StaffAppointmentsParams = {
  type?: string | null;
  status?: string | null;
  search?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  /**
   * #674 defect 13 — required, not optional. This surface reads EVERY tenant
   * by default, so "no scope passed" and "the operator deliberately wants the
   * platform view" used to look identical at the call site. Naming
   * `{ kind: "all" }` makes that a decision someone wrote down.
   */
  scope: Scope;
  page?: number;
  limit?: number;
};

/**
 * #897 — map the derived display status (the staff tabs: scheduled / completed
 * / issue) to a DB condition across the four event types, so filtering and the
 * tab counts run in the query instead of on an already-paginated page.
 *
 * "issue" mirrors the per-row hasIssue rule: cancelled, OR no payment with a
 * non-PENDING status (webinar/class have no PENDING state, so any unpaid one
 * qualifies). Returns null for "all"/unknown — no status constraint.
 */
function buildStatusWhere(
  status: string | null,
): Prisma.AppointmentWhereInput | null {
  if (status === "scheduled" || status === "completed") {
    const s = status === "scheduled" ? "SCHEDULED" : "COMPLETED";
    return {
      OR: [
        { consultation: { status: s } },
        { subscription: { status: s } },
        { webinar: { status: s } },
        { class: { status: s } },
      ],
    };
  }
  if (status === "issue") {
    return {
      OR: [
        { consultation: { status: "CANCELLED" } },
        { subscription: { status: "CANCELLED" } },
        { webinar: { status: "CANCELLED" } },
        { class: { status: "CANCELLED" } },
        {
          AND: [
            { payment: { none: {} } },
            {
              OR: [
                { consultation: { status: { not: "PENDING" } } },
                { subscription: { status: { not: "PENDING" } } },
                { webinarId: { not: null } },
                { classId: { not: null } },
              ],
            },
          ],
        },
      ],
    };
  }
  return null;
}

/**
 * Fetch the staff appointments table as a JSON-safe payload.
 *
 * Single source of truth for both the route and the prefetch — the returned
 * object is the exact shape the client useQuery(["staff-appointments", ...])
 * caches. Date fields are pre-serialized to ISO strings here so the
 * SSR-dehydrated cache matches the client fetch verbatim.
 */
export async function getStaffAppointments(
  params: StaffAppointmentsParams,
): Promise<StaffAppointmentsPayload> {
  const type = (params.type as AppointmentsType | null) ?? null;
  const status = params.status ?? null;
  const search = params.search ?? null;
  const dateFrom = params.dateFrom ?? null;
  const dateTo = params.dateTo ?? null;
  // #674 comment 7 — org-scope filter for support staff drilling into a single
  // tenant's appointments. Uses Appointment.organizationId.
  const orgWhere = scopeToWhereOrgId(params.scope);
  const page = params.page ?? 1;
  const limit = params.limit ?? 20;
  const offset = (page - 1) * limit;

  // Base where (type / org / date / search) — NOT status. #897: status is a
  // derived value (per-type sub-entity status + payment presence), so it's
  // resolved to DB conditions and AND-ed in below, instead of post-filtering a
  // single page (which broke page sizes and totals).
  const baseWhere: Prisma.AppointmentWhereInput = { ...orgWhere };

  if (type && Object.values(AppointmentsType).includes(type)) {
    baseWhere.appointmentType = type;
  }

  // Filter by date at the database level using slotsOfAppointment
  if (dateFrom || dateTo) {
    baseWhere.slotsOfAppointment = {
      some: {
        ...(dateFrom && { startsAt: { gte: new Date(dateFrom) } }),
        ...(dateTo && { startsAt: { lte: new Date(dateTo) } }),
      },
    };
  }

  // Handle search across multiple fields
  if (search) {
    baseWhere.OR = [
      { id: { contains: search, mode: "insensitive" } },
      // Consultation search
      {
        consultation: {
          consultationPlan: {
            title: { contains: search, mode: "insensitive" },
          },
        },
      },
      {
        consultation: {
          consultationPlan: {
            consultantProfile: {
              user: {
                OR: [
                  { name: { contains: search, mode: "insensitive" } },
                  { email: { contains: search, mode: "insensitive" } },
                ],
              },
            },
          },
        },
      },
      {
        consultation: {
          requestedBy: {
            user: {
              OR: [
                { name: { contains: search, mode: "insensitive" } },
                { email: { contains: search, mode: "insensitive" } },
              ],
            },
          },
        },
      },
      // Subscription search
      {
        subscription: {
          subscriptionPlan: {
            title: { contains: search, mode: "insensitive" },
          },
        },
      },
      // Webinar search
      {
        webinar: {
          webinarPlan: {
            title: { contains: search, mode: "insensitive" },
          },
        },
      },
      // Class search
      {
        class: {
          classPlan: {
            title: { contains: search, mode: "insensitive" },
          },
        },
      },
    ];
  }

  // #897 — AND the resolved status condition onto the base for the list query
  // so pagination + total reflect the filtered set.
  const statusCond = buildStatusWhere(status);
  const listWhere: Prisma.AppointmentWhereInput = statusCond
    ? { AND: [baseWhere, statusCond] }
    : baseWhere;

  // One paginated list query + per-tab count queries. `total` drives
  // pagination for the CURRENT view; the tab badges are global counts within
  // the base filter (not page-scoped), which is the #897 fix.
  const [
    appointments,
    total,
    allCount,
    scheduledCount,
    completedCount,
    issuesCount,
  ] = await Promise.all([
    prisma.appointment.findMany({
      where: listWhere,
      include: {
        slotsOfAppointment: {
          orderBy: { startsAt: "asc" },
          take: 1,
          select: {
            id: true,
            startsAt: true,
            endsAt: true,
            isTentative: true,
            // Group events share their slots across every registrant, so one
            // slot's user count is the attendee count.
            _count: { select: { user: true } },
          },
        },
        consultation: {
          select: {
            id: true,
            status: true,
            consultationPlan: {
              select: {
                id: true,
                title: true,
                price: true,
                priceCurrency: true,
                durationInHours: true,
                consultantProfile: {
                  select: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
            requestedBy: {
              select: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                  },
                },
              },
            },
          },
        },
        subscription: {
          select: {
            id: true,
            status: true,
            subscriptionPlan: {
              select: {
                id: true,
                title: true,
                price: true,
                priceCurrency: true,
                consultantProfile: {
                  select: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
            requestedBy: {
              select: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                  },
                },
              },
            },
          },
        },
        webinar: {
          select: {
            id: true,
            status: true,
            webinarPlan: {
              select: {
                id: true,
                title: true,
                price: true,
                priceCurrency: true,
                maxParticipants: true,
                consultantProfile: {
                  select: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        class: {
          select: {
            id: true,
            status: true,
            classPlan: {
              select: {
                id: true,
                title: true,
                price: true,
                priceCurrency: true,
                maxParticipants: true,
                consultantProfile: {
                  select: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        payment: {
          select: {
            id: true,
            amount: true,
            currency: true,
            paymentStatus: true,
            paymentGateway: true,
            createdAt: true,
          },
          take: 1,
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.appointment.count({ where: listWhere }),
    prisma.appointment.count({ where: baseWhere }),
    prisma.appointment.count({
      where: { AND: [baseWhere, buildStatusWhere("scheduled") ?? {}] },
    }),
    prisma.appointment.count({
      where: { AND: [baseWhere, buildStatusWhere("completed") ?? {}] },
    }),
    prisma.appointment.count({
      where: { AND: [baseWhere, buildStatusWhere("issue") ?? {}] },
    }),
  ]);

  // Format appointments for frontend
  const formattedAppointments = appointments.map((apt) => {
    // Get consultant and consultee info based on type
    let consultant = null;
    let consultee = null;
    let title = "";
    let aptStatus = null;
    let duration = 0;
    const attendeeCount = apt.slotsOfAppointment[0]?._count.user ?? 0;

    switch (apt.appointmentType) {
      case "CONSULTATION":
        if (apt.consultation) {
          consultant = apt.consultation.consultationPlan.consultantProfile.user;
          consultee = apt.consultation.requestedBy.user;
          title = apt.consultation.consultationPlan.title;
          aptStatus = apt.consultation.status;
          duration = apt.consultation.consultationPlan.durationInHours * 60;
        }
        break;
      case "SUBSCRIPTION":
        if (apt.subscription) {
          consultant = apt.subscription.subscriptionPlan.consultantProfile.user;
          consultee = apt.subscription.requestedBy.user;
          title = apt.subscription.subscriptionPlan.title;
          aptStatus = apt.subscription.status;
        }
        break;
      case "WEBINAR":
        if (apt.webinar) {
          consultant = apt.webinar.webinarPlan.consultantProfile?.user || null;
          consultee = {
            id: "",
            name: attendeeLabel(attendeeCount, "attendee"),
            email: "",
            image: null,
          };
          title = apt.webinar.webinarPlan.title;
          aptStatus = apt.webinar.status;
        }
        break;
      case "CLASS":
        if (apt.class) {
          consultant = apt.class.classPlan.consultantProfile?.user || null;
          consultee = {
            id: "",
            name: attendeeLabel(attendeeCount, "student"),
            email: "",
            image: null,
          };
          title = apt.class.classPlan.title;
          aptStatus = apt.class.status;
        }
        break;
    }

    const slot = apt.slotsOfAppointment[0];
    const payment = apt.payment[0];

    // Determine status for display
    let displayStatus = "scheduled";
    if (aptStatus) {
      const statusStr = String(aptStatus).toLowerCase();
      if (statusStr === "cancelled") displayStatus = "cancelled";
      else if (statusStr === "completed") displayStatus = "completed";
      else if (statusStr === "in_progress") displayStatus = "in_progress";
      else if (statusStr === "scheduled") displayStatus = "scheduled";
      else displayStatus = statusStr;
    }

    // Check if there's an issue (cancelled, no payment, etc.)
    const hasIssue =
      displayStatus === "cancelled" || (!payment && aptStatus !== "PENDING");

    // Date→ISO so the payload is JSON-safe verbatim (matches NextResponse.json)
    const scheduledAtDate = slot?.startsAt || apt.createdAt;

    return {
      id: apt.id,
      type: apt.appointmentType.toLowerCase(),
      title,
      consultant: consultant
        ? {
            id: consultant.id,
            name: consultant.name,
            email: consultant.email,
            avatar: consultant.image,
          }
        : null,
      consultee: consultee
        ? {
            id: (consultee as { id?: string }).id || "",
            name: (consultee as { name?: string | null }).name ?? null,
            email: (consultee as { email?: string | null }).email ?? null,
            avatar: (consultee as { image?: string | null }).image ?? null,
          }
        : null,
      scheduledAt: scheduledAtDate.toISOString(),
      endsAt: slot?.endsAt ? slot.endsAt.toISOString() : undefined,
      duration,
      status: displayStatus,
      hasIssue,
      issueType: hasIssue
        ? displayStatus === "cancelled"
          ? "Cancelled"
          : "Payment pending"
        : null,
      payment: payment
        ? {
            id: payment.id,
            amount: payment.amount,
            currency: payment.currency,
            status: payment.paymentStatus,
            gateway: payment.paymentGateway,
          }
        : null,
      createdAt: apt.createdAt.toISOString(),
    };
  });

  // #897 — status filtering and counts now run in the DB above, so the page is
  // already the correct slice and the tab badges are global, not page-scoped.
  const counts = {
    all: allCount,
    issues: issuesCount,
    scheduled: scheduledCount,
    completed: completedCount,
  };

  // toPlain — payment rows carry the #780/#781 money result extension's inspect
  // symbol, so the payload must be plainified before crossing the RSC→Client
  // HydrationBoundary.
  return toPlain({
    appointments: formattedAppointments,
    counts,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasMore: offset + limit < total,
    },
  });
}
