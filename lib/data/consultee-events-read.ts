/**
 * Shared read for the consultee events surface. #890
 *
 * Single source of truth for the 5-booking-type union the consultee
 * dashboard Home + Appointments views render. Both the API route
 * (`/api/dashboard/consultee/[consulteeId]/events`) and the consultee
 * home server page call this directly so SSR hydration and the client
 * `useQuery` resolve byte-identical payloads — the route wraps it in
 * `{ data, success }`, the prefetch returns it raw (matching
 * `fetchWithErrorHandling`'s `json.data` unwrap).
 *
 * Auth + `?orgScope=` resolution stay in the route; this function takes
 * an already-resolved `Scope` so it carries no request/session coupling
 * and is callable from a Server Component.
 */

import { reportSentryError } from "@/lib/observability/report";
import prisma from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import type { Scope } from "@/lib/api/scope/parse";
import { scopeToWhereOrgId } from "@/lib/api/scope/parse";
import { toPlain } from "@/lib/data/serialize";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import type { TConsulteeEventsResponse } from "@/types/consultee-events";

/**
 * #1163 — the live proposal, so the consultee SEES a consultant-initiated
 * reschedule and can answer it (accept / decline / withdraw), instead of
 * "Awaiting schedule confirmation" forever.
 *
 * Only the two 1:1 kinds carry proposals (`supportsProposals`), and the respond
 * route refuses anything else, so this rides consultation + subscription and
 * nothing else — loading it on a group event would cost a relation read per row
 * on a TTFB-bound query to render an answer nobody can give.
 */
const liveProposalInclude = {
  where: { status: { in: ["PENDING_REVIEW", "COUNTERED"] } },
  orderBy: { createdAt: "desc" },
  take: 1,
  select: {
    id: true,
    status: true,
    reason: true,
    round: true,
    expiresAt: true,
    initiatorRole: true,
    initiatedById: true,
    proposedSlots: {
      orderBy: { startsAt: "asc" },
      // #1163 — the consultee card filters these to the current round.
      select: { startsAt: true, endsAt: true, round: true },
    },
  },
} satisfies Prisma.Appointment$rescheduleRequestsArgs;

/** Thrown when the consulteeId has no profile — route maps to 404. */
export class ConsulteeProfileNotFoundError extends Error {
  constructor(consulteeId: string) {
    super(`Consultee profile not found: ${consulteeId}`);
    this.name = "ConsulteeProfileNotFoundError";
  }
}

/**
 * Read the consultee's event union for a resolved scope. Returns the
 * inner payload shape (NOT wrapped in `{ data, success }`).
 */
export async function readConsulteeEvents(
  consulteeId: string,
  scope: Scope,
): Promise<TConsulteeEventsResponse> {
  // Get the userId from the consultee profile to match slot membership
  const consulteeProfile = await prisma.consulteeProfile.findUnique({
    where: { id: consulteeId },
    select: { userId: true },
  });

  if (!consulteeProfile) {
    // Modelled: the route maps this to a 404 (see class docstring) —
    // captured for visibility only (stale link / deleted profile), not a
    // fault in this read.
    const notFoundErr = new ConsulteeProfileNotFoundError(consulteeId);
    reportSentryError(notFoundErr, { subsystem: "consultees", expected: true });
    throw notFoundErr;
  }

  const userId = consulteeProfile.userId;

  // Build per-resource org filters. The 5 booking models attach to
  // org context differently:
  //   - Consultation / Webinar (1:1 appointment): filter via
  //     `appointment.is.organizationId`
  //   - Subscription / Class (1:many appointments): filter via
  //     `appointments.some.organizationId` so the parent surfaces if
  //     ANY child appointment matches the scope
  //   - TrialSession: filter directly via `organizationId`
  //
  // #674 B2B gap 9 — `orgMember` pins an org too: it is what an active member
  // below `operations.read` resolves to. Branching on `kind === "org"` alone
  // left them with NO org filter at all, so asking for one org's events
  // returned every org's plus the personal ones. Only `all` is genuinely
  // unfiltered, so that is the only kind that yields `undefined` here.
  const oneApptOrgWhere: Prisma.AppointmentWhereInput | undefined =
    scope.kind === "all" ? undefined : scopeToWhereOrgId(scope);
  const manyApptOrgWhere: Prisma.AppointmentWhereInput | undefined =
    oneApptOrgWhere;
  const trialOrgWhere: Prisma.TrialSessionWhereInput | undefined =
    scope.kind === "all" ? undefined : scopeToWhereOrgId(scope);

  // TTFB bound: cap each booking query to recent-or-future rows. The
  // consultee Home calendar lets users page backward month-by-month, so
  // the lower bound is 1 year (not 90 days) to keep that browse window
  // intact while a multi-year veteran no longer pulls full history.
  const since = new Date();
  since.setFullYear(since.getFullYear() - 1);
  const EVENTS_TAKE = 200;

  // PERFORMANCE FIX: Use direct Prisma queries instead of internal HTTP fetches
  // This avoids network overhead and reduces response time from 11+ seconds to <1 second
  const [consultations, subscriptions, webinars, classes, trials] =
    await Promise.all([
      prisma.consultation.findMany({
        where: {
          requestedById: consulteeId,
          // Org scope only — NO slot requirement. The Appointments → Upcoming
          // view renders slot-less PENDING bookings (pending-payment CTA), so
          // requiring an in-window slot would hide them. take:EVENTS_TAKE bounds
          // the row count instead. #887
          ...(oneApptOrgWhere && { appointment: { is: oneApptOrgWhere } }),
        },
        include: {
          consultationPlan: {
            include: {
              consultantProfile: {
                select: {
                  ...consultantPublicScalars,
                  user: {
                    select: {
                      id: true,
                      name: true,
                      image: true,
                      email: true,
                    },
                  },
                },
              },
            },
          },
          appointment: {
            include: {
              rescheduleRequests: liveProposalInclude,
              slotsOfAppointment: {
                orderBy: { startsAt: "asc" },
                include: {
                  meetingSession: {
                    select: { id: true, endedAt: true, endedReason: true },
                  },
                },
              },
              payment: true,
            },
          },
        },
        orderBy: { requestedAt: "desc" },
        take: EVENTS_TAKE,
      }),
      prisma.subscription.findMany({
        where: {
          requestedById: consulteeId,
          // Org scope only — NO slot requirement (see consultation above);
          // take:EVENTS_TAKE bounds the row count without hiding slot-less
          // PENDING subscriptions. #887
          ...(manyApptOrgWhere && { appointments: { some: manyApptOrgWhere } }),
        },
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                select: {
                  ...consultantPublicScalars,
                  user: {
                    select: {
                      id: true,
                      name: true,
                      image: true,
                      email: true,
                    },
                  },
                },
              },
            },
          },
          appointments: {
            include: {
              rescheduleRequests: liveProposalInclude,
              slotsOfAppointment: {
                orderBy: { startsAt: "asc" },
                include: {
                  meetingSession: {
                    select: { id: true, endedAt: true, endedReason: true },
                  },
                },
              },
              payment: true,
            },
          },
        },
        orderBy: { requestedAt: "desc" },
        take: EVENTS_TAKE,
      }),
      // Webinars the user registered for.
      prisma.webinar.findMany({
        where: {
          appointment: {
            slotsOfAppointment: {
              // TTFB bound: the user must own a slot AND it must be in-window.
              some: {
                user: { some: { id: userId } },
                startsAt: { gte: since },
              },
            },
            ...(oneApptOrgWhere ?? {}),
          },
        },
        include: {
          webinarPlan: {
            include: {
              consultantProfile: {
                select: {
                  ...consultantPublicScalars,
                  user: {
                    select: {
                      id: true,
                      name: true,
                      image: true,
                      email: true,
                    },
                  },
                },
              },
              collaborators: {
                where: { status: "ACCEPTED" },
                include: {
                  consultantProfile: {
                    select: {
                      ...consultantPublicScalars,
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
          appointment: {
            include: {
              slotsOfAppointment: {
                orderBy: { startsAt: "asc" },
                include: {
                  meetingSession: {
                    select: { id: true, endedAt: true, endedReason: true },
                  },
                },
              },
              payment: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: EVENTS_TAKE,
      }),
      // Classes the user enrolled in.
      prisma.class.findMany({
        where: {
          appointments: {
            some: {
              slotsOfAppointment: {
                // TTFB bound: the user must own a slot AND it must be in-window.
                some: {
                  user: { some: { id: userId } },
                  startsAt: { gte: since },
                },
              },
              ...(manyApptOrgWhere ?? {}),
            },
          },
        },
        include: {
          classPlan: {
            include: {
              consultantProfile: {
                select: {
                  ...consultantPublicScalars,
                  user: {
                    select: {
                      id: true,
                      name: true,
                      image: true,
                      email: true,
                    },
                  },
                },
              },
              collaborators: {
                where: { status: "ACCEPTED" },
                include: {
                  consultantProfile: {
                    select: {
                      ...consultantPublicScalars,
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
          appointments: {
            include: {
              slotsOfAppointment: {
                orderBy: { startsAt: "asc" },
                include: {
                  meetingSession: {
                    select: { id: true, endedAt: true, endedReason: true },
                  },
                },
              },
              payment: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: EVENTS_TAKE,
      }),
      // Trial sessions requested by the consultee
      prisma.trialSession.findMany({
        where: {
          consulteeProfileId: consulteeId,
          ...(trialOrgWhere ?? {}),
          // TTFB bound: trials may be PENDING with no appointment/slot
          // yet, so bound by requestedAt (the orderBy field) rather than
          // slot start to avoid dropping recent slot-less trials.
          requestedAt: { gte: since },
        },
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                select: {
                  ...consultantPublicScalars,
                  user: {
                    select: {
                      id: true,
                      name: true,
                      image: true,
                      email: true,
                    },
                  },
                },
              },
            },
          },
          appointment: {
            include: {
              slotsOfAppointment: {
                orderBy: { startsAt: "asc" },
                include: {
                  user: {
                    select: {
                      id: true,
                      name: true,
                      email: true,
                      image: true,
                    },
                  },
                  meetingSession: {
                    select: { id: true, endedAt: true, endedReason: true },
                  },
                },
              },
            },
          },
        },
        orderBy: { requestedAt: "desc" },
        take: EVENTS_TAKE,
      }),
    ]);

  // toPlain — the booking rows include money-extended plan/payment
  // relations (#780/#781 result extensions) that carry Prisma's inspect
  // symbol; they must be plainified before crossing the RSC→Client
  // HydrationBoundary. The route path (NextResponse.json) drops symbols
  // anyway, so this only matters for the SSR prefetch. Preserves Dates.
  return toPlain({
    consultations,
    subscriptions,
    webinars,
    classes,
    trials,
  }) as unknown as TConsulteeEventsResponse;
}
