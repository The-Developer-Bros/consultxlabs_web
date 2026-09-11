/**
 * Shared read for the consultant Appointments list. #890
 *
 * Single source of truth for the appointment-list payload behind
 * `GET /api/slots/appointments`. Both that route and the consultant
 * Appointments server page call this directly so SSR hydration and the
 * client `useQuery` resolve identical payloads — the route wraps it in
 * `{ data }`, the prefetch returns it raw (matching
 * `fetchWithErrorHandling`'s `json.data` unwrap).
 *
 * Auth + `?orgScope=` resolution stay in the route; this function carries
 * no request/session coupling and is callable from a Server Component. The
 * route resolves the Scope and passes it through unflattened — projecting it
 * to a WHERE clause happens here, via the shared projector, so a caller can no
 * longer get the projection subtly wrong on its own (#674 defect 13).
 *
 * Serialization: appointment rows spread the money-`$extends` plan/payment
 * models (#780/#781 result extension carries an inspect symbol), so the
 * return is wrapped in `toPlain(...)` before it can cross the RSC→Client
 * HydrationBoundary. The route path (NextResponse.json) was always fine —
 * JSON drops symbols — so this only matters for the SSR prefetch. Dates
 * stay Dates.
 */

import prisma from "@/lib/prisma";
import { AppointmentsType, AppointmentStatus, Prisma } from "@prisma/client";
import type { User } from "@prisma/client";
import { toPlain } from "@/lib/data/serialize";
import type { TAppointment } from "@/types/appointment";
import type { Scope } from "@/lib/api/scope/parse";
import { scopeToWhereOrgId } from "@/lib/api/scope/parse";

export interface GetConsultantAppointmentsArgs {
  type?: AppointmentsType;
  consultantProfileId?: string | null;
  consulteeProfileId?: string | null;
  userId?: string | null;
  statuses?: {
    consultation?: string;
    subscription?: string;
    webinar?: string;
    class?: string;
  };
  startDate?: string | null;
  endDate?: string | null;
  eventIds?: {
    webinarId?: string | null;
    classId?: string | null;
    consultationId?: string | null;
    subscriptionId?: string | null;
  };
  /// #674 org scope resolved upstream (`resolveOrgScope`). Required: this
  /// read spans every tenant when unfiltered, so the caller has to say which
  /// slice it means rather than inheriting one.
  scope: Scope;
}

/**
 * Read the appointment list (sorted by first slot start time). Returns the
 * inner array (NOT wrapped in `{ data }`). Auth/scope checks are the
 * caller's responsibility.
 *
 * The consultant Appointments page calls this with just
 * `{ consultantProfileId, scope: { kind: "personal" } }` (the default
 * "personal" view); the route passes the full arg set parsed from the
 * request query string.
 */
/**
 * Slot users on this surface are projected down to `listUserSelect`. TAppointment
 * still declares the full User relation, so name the narrower shape here instead
 * of letting the `as unknown as` at the bottom imply fields that were never
 * queried — reading e.g. `.role` off one of these is `undefined` at runtime.
 */
type ListSlotUser = Pick<User, "id" | "name" | "email" | "image">;
export type ConsultantListAppointment = Omit<
  TAppointment,
  "slotsOfAppointment"
> & {
  slotsOfAppointment: (Omit<
    TAppointment["slotsOfAppointment"][number],
    "user"
  > & { user: ListSlotUser[] })[];
};

export async function getConsultantAppointments(
  args: GetConsultantAppointmentsArgs,
): Promise<ConsultantListAppointment[]> {
  const {
    type,
    consultantProfileId,
    consulteeProfileId,
    userId,
    statuses,
    startDate,
    endDate,
    eventIds,
    scope,
  } = args;

  const whereClause: Prisma.AppointmentWhereInput = {
    ...scopeToWhereOrgId(scope),
  };

  // Date range filtering for appointments. This is the primary filter.
  // It looks for appointments where any of its slots overlap with the given date range.
  // Also includes appointments with no slots (they'll be shown but sorted to the end)
  if (startDate && endDate) {
    whereClause.OR = [
      // Appointments with slots overlapping the date range
      {
        slotsOfAppointment: {
          some: {
            AND: [
              { startsAt: { lt: new Date(endDate) } },
              { endsAt: { gt: new Date(startDate) } },
            ],
          },
        },
      },
      // OR appointments with no slots at all
      {
        slotsOfAppointment: {
          none: {},
        },
      },
    ];
  }

  const userFilterClauses: Prisma.AppointmentWhereInput[] = [];
  if (consultantProfileId) {
    userFilterClauses.push({
      OR: [
        {
          consultation: {
            consultationPlan: { consultantProfileId },
          },
        },
        {
          subscription: {
            subscriptionPlan: { consultantProfileId },
          },
        },
        {
          webinar: {
            webinarPlan: { consultantProfileId },
          },
        },
        {
          // Collaborated webinars (co-host, moderator, etc.)
          webinar: {
            webinarPlan: {
              collaborators: {
                some: {
                  consultantProfileId,
                  status: "ACCEPTED",
                },
              },
            },
          },
        },
        {
          class: {
            classPlan: { consultantProfileId },
          },
        },
        {
          // Collaborated classes (co-instructor, TA, etc.)
          class: {
            classPlan: {
              collaborators: {
                some: {
                  consultantProfileId,
                  status: "ACCEPTED",
                },
              },
            },
          },
        },
      ],
    });
  }

  if (consulteeProfileId) {
    userFilterClauses.push({
      OR: [
        {
          consultation: {
            requestedBy: { id: consulteeProfileId },
          },
        },
        {
          subscription: {
            requestedBy: { id: consulteeProfileId },
          },
        },
        {
          slotsOfAppointment: {
            some: {
              user: { some: { consulteeProfileId: consulteeProfileId } },
            },
          },
        },
      ],
    });
  }

  if (userId) {
    userFilterClauses.push({
      slotsOfAppointment: {
        some: {
          user: {
            some: {
              id: userId,
            },
          },
        },
      },
    });
  }

  if (userFilterClauses.length > 0) {
    whereClause.AND = userFilterClauses;
  }

  if (type) {
    whereClause.appointmentType = type;
  }

  // Filter by specific event IDs
  if (eventIds?.webinarId) {
    whereClause.webinar = { id: eventIds.webinarId };
  }
  if (eventIds?.classId) {
    whereClause.class = { id: eventIds.classId };
  }
  if (eventIds?.consultationId) {
    whereClause.consultation = { id: eventIds.consultationId };
  }
  if (eventIds?.subscriptionId) {
    whereClause.subscription = { id: eventIds.subscriptionId };
  }

  // FIX #551: Apply status filters that were previously parsed but never used.
  // Build an OR clause so appointments matching ANY of the provided status
  // filters are returned (allows fetching e.g., APPROVED consultations AND
  // SCHEDULED webinars in one call).
  const statusFilters: Prisma.AppointmentWhereInput[] = [];
  if (statuses?.consultation) {
    statusFilters.push({
      consultation: { status: statuses.consultation as AppointmentStatus },
    });
  }
  if (statuses?.subscription) {
    statusFilters.push({
      subscription: { status: statuses.subscription as AppointmentStatus },
    });
  }
  if (statuses?.webinar) {
    statusFilters.push({
      webinar: { status: statuses.webinar as Prisma.EnumWebinarStatusFilter },
    });
  }
  if (statuses?.class) {
    statusFilters.push({
      class: { status: statuses.class as Prisma.EnumClassStatusFilter },
    });
  }
  if (statusFilters.length > 0) {
    // Combine with existing AND clauses
    const existingAnd = whereClause.AND
      ? Array.isArray(whereClause.AND)
        ? whereClause.AND
        : [whereClause.AND]
      : [];
    whereClause.AND = [...existingAnd, { OR: statusFilters }];
  }

  const listUserSelect = {
    id: true,
    name: true,
    email: true,
    image: true,
  } as const;

  const appointments = await prisma.appointment.findMany({
    where: whereClause,
    include: {
      slotsOfAppointment: {
        orderBy: { startsAt: "asc" },
        include: {
          user: { select: listUserSelect },
          meetingSession: {
            select: { id: true, endedAt: true, endedReason: true },
          },
        },
      },
      consultation: {
        include: {
          consultationPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: { select: listUserSelect },
                },
              },
            },
          },
          requestedBy: {
            include: {
              user: { select: listUserSelect },
            },
          },
        },
      },
      subscription: {
        select: {
          id: true,
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: { select: listUserSelect },
                },
              },
            },
          },
          requestedBy: {
            include: {
              user: { select: listUserSelect },
            },
          },
          schedulingPeriodStartsAt: true,
          schedulingPeriodEndsAt: true,
          // #997 Phase 3 — the appointments route's weekly-confirmed-call-count
          // aggregate buckets by THIS column (ADR B9), not a client-passed tz.
          schedulingTimezone: true,
          status: true,
        },
      },
      webinar: {
        include: {
          webinarPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: { select: listUserSelect },
                },
              },
              collaborators: {
                where: { status: "ACCEPTED" },
                include: {
                  consultantProfile: {
                    include: {
                      user: {
                        select: {
                          id: true,
                          name: true,
                          image: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      class: {
        include: {
          classPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: { select: listUserSelect },
                },
              },
              collaborators: {
                where: { status: "ACCEPTED" },
                include: {
                  consultantProfile: {
                    include: {
                      user: {
                        select: {
                          id: true,
                          name: true,
                          image: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  // Sort appointments by slot start time
  // Include appointments with 0 slots (push them to the end)
  const sorted = appointments.sort((a, b) => {
    const aTime = a.slotsOfAppointment?.[0]?.startsAt;
    const bTime = b.slotsOfAppointment?.[0]?.startsAt;

    // Appointments without slots go to the end
    if (!aTime && !bTime) return 0;
    if (!aTime) return 1;
    if (!bTime) return -1;

    return new Date(aTime).getTime() - new Date(bTime).getTime();
  });

  // toPlain — rows spread the money-extended plan/payment models (#780/#781
  // result extension carries an inspect symbol), so the payload must be
  // plainified before it crosses the RSC→Client HydrationBoundary. Preserves
  // Dates as Dates. No-op for the route path (JSON drops symbols).
  return toPlain(sorted) as unknown as ConsultantListAppointment[];
}
