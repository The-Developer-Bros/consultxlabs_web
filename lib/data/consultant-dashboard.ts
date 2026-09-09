/**
 * Shared read for the consultant Home dashboard. #890
 *
 * Single source of truth for the consultant dashboard payload the Home
 * tab renders. Both the API route (`/api/dashboard/consultant/[id]`) and
 * the consultant home server page call this directly so SSR hydration and
 * the client `useQuery` resolve identical payloads — the route wraps it in
 * `{ success, data }`, the prefetch returns it raw (matching
 * `fetchWithErrorHandling`'s `json.data` unwrap).
 *
 * Auth + access checks stay in the route; this function carries no
 * request/session coupling and is callable from a Server Component.
 *
 * Serialization: money fields are `number` here — read-path includes go
 * through the prisma `$extends` (bigint/Decimal→number), and the `_sum`
 * aggregates (which bypass that extension) are run through `sumPaise`.
 * Slot/activity `Date` values stay raw `Date`; they round-trip through
 * RSC dehydration and the client helpers wrap every value in `new Date()`.
 */

import prisma from "@/lib/prisma";
import { scopeToWhereOrgId } from "@/lib/api/scope/parse";
import { readByIds } from "@/lib/data/read-by-ids";
import {
  pendingConsultationWhere,
  pendingSubscriptionWhere,
} from "@/lib/data/needs-you";
import { Prisma } from "@prisma/client";
import { PAYOUT_CONSTANTS } from "@/lib/payments/payouts/constants";
import { sumPaise } from "@/lib/payments/utils/money";
import { toPlain } from "@/lib/data/serialize";
import type { TConsultantDashboardResponse } from "@/types/consultant-events";

// =============================================================================
// Prisma Query Types - Derived from actual query shape for type safety
// =============================================================================

/** Home widgets only need identity + avatar; omit phone/role from the graph. */
const userSelectFields = {
  id: true,
  name: true,
  email: true,
  image: true,
} as const;

/** Approvals list only needs the requester display name. */
const pendingUserSelect = {
  id: true,
  name: true,
  image: true,
} as const;

/** Home surfaces a handful of cards — history lives on /appointments. */
const HOME_APPOINTMENTS_TAKE = 20;
const HOME_PENDING_TAKE = 20;

/**
 * #1166 ORG-1 — personal Home is B2C only (ADR 19), matching the sibling
 * Appointments page's personal filter; org delivery lives on that org's own
 * dashboard. #674 defect 13 — the pin is taken from the shared projector
 * rather than written out as a literal at each of the four sites below, so
 * "what personal means" has exactly one definition on the platform.
 */
const PERSONAL_ORG_PIN = scopeToWhereOrgId({ kind: "personal" });

/**
 * Every appointment this consultant owns or collaborates on. Shared by the
 * Home display read and the active-clients count so the two can never drift.
 */
const consultantAppointmentScope = (consultantProfileId: string) =>
  ({
    ...PERSONAL_ORG_PIN,
    OR: [
      {
        consultation: {
          consultationPlan: { consultantProfileId },
          status: "APPROVED" as const,
        },
      },
      {
        subscription: {
          subscriptionPlan: { consultantProfileId },
          status: "APPROVED" as const,
        },
      },
      {
        webinar: {
          webinarPlan: { consultantProfileId },
          status: "SCHEDULED" as const,
        },
      },
      {
        // Collaborated webinars (co-host, moderator, etc.)
        webinar: {
          webinarPlan: {
            collaborators: {
              some: { consultantProfileId, status: "ACCEPTED" as const },
            },
          },
          status: "SCHEDULED" as const,
        },
      },
      {
        class: {
          classPlan: { consultantProfileId },
          status: "SCHEDULED" as const,
        },
      },
      {
        // Collaborated classes (co-instructor, TA, etc.)
        class: {
          classPlan: {
            collaborators: {
              some: { consultantProfileId, status: "ACCEPTED" as const },
            },
          },
          status: "SCHEDULED" as const,
        },
      },
    ],
  }) satisfies Prisma.AppointmentWhereInput;

const appointmentInclude = {
  slotsOfAppointment: {
    orderBy: { startsAt: "asc" as const },
    include: {
      user: {
        select: userSelectFields,
      },
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
              user: {
                select: userSelectFields,
              },
            },
          },
        },
      },
      requestedBy: {
        include: {
          user: {
            select: userSelectFields,
          },
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
              user: {
                select: userSelectFields,
              },
            },
          },
        },
      },
      requestedBy: {
        include: {
          user: {
            select: userSelectFields,
          },
        },
      },
      schedulingPeriodStartsAt: true,
      schedulingPeriodEndsAt: true,
      status: true,
    },
  },
  webinar: {
    include: {
      webinarPlan: {
        include: {
          consultantProfile: {
            include: {
              user: {
                select: userSelectFields,
              },
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
              user: {
                select: userSelectFields,
              },
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
} satisfies Prisma.AppointmentInclude;

/** Pending-approvals widget only needs id + requester name + requestedAt. */
const pendingConsultationInclude = {
  requestedBy: {
    include: {
      user: {
        select: pendingUserSelect,
      },
    },
  },
} satisfies Prisma.ConsultationInclude;

const pendingSubscriptionInclude = {
  requestedBy: {
    include: {
      user: {
        select: pendingUserSelect,
      },
    },
  },
} satisfies Prisma.SubscriptionInclude;

// Derive types from the include objects via the extended client — raw
// GetPayload would re-introduce bigint money fields (#780).
type DashboardAppointment = Prisma.Result<
  typeof prisma.appointment,
  { include: typeof appointmentInclude },
  "findFirstOrThrow"
>;
type DashboardConsultation = Prisma.Result<
  typeof prisma.consultation,
  { include: typeof pendingConsultationInclude },
  "findFirstOrThrow"
>;
type DashboardSubscription = Prisma.Result<
  typeof prisma.subscription,
  { include: typeof pendingSubscriptionInclude },
  "findFirstOrThrow"
>;

// =============================================================================
// Helper Functions
// =============================================================================

function formatDate(dateString?: string | Date | null): string {
  if (!dateString) return "Date not set";
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return "Invalid date";

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(dateString?: string | Date | null): string {
  if (!dateString) return "Time not set";
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return "Invalid time";

  return date.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function getRelativeTime(date: Date): string {
  const now = new Date();
  // Use Math.max to handle potential future dates (e.g., clock skew)
  const diffMs = Math.max(0, now.getTime() - new Date(date).getTime());
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) {
    return "just now";
  } else if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else if (diffDays === 1) {
    return "1d ago";
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  } else {
    return formatDate(date);
  }
}

// =============================================================================
// Shared Read
// =============================================================================

/**
 * Read + transform the consultant Home dashboard payload. Returns the
 * inner shape (NOT wrapped in `{ success, data }`). Auth/access checks
 * are the caller's responsibility.
 */
export async function getConsultantDashboard(
  consultantProfileId: string,
): Promise<TConsultantDashboardResponse> {
  // --- Performance Snapshot date boundaries ---
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  // Which appointments Home actually shows. Appointment has no top-level start
  // column, so a plain `orderBy: createdAt` + `take` truncated on the wrong key:
  // a consultant who booked next month a fortnight ago and then took a burst of
  // bookings for last week got 20 rows that were all in the past, and both the
  // Today and Upcoming widgets rendered empty. Rank on the slot table instead —
  // it has @@index([startsAt, endsAt]) — and keep only the soonest ids. Slots
  // are per-appointment, so over-fetch before deduping to ids.
  //
  // Anchor on endsAt >= start of today, NOT on a lower bound in the past:
  // ordering ascending from 90 days ago returns the OLDEST slots in the window,
  // which reproduces the empty-widget bug in a new disguise. Using endsAt keeps
  // a session that started earlier today and is still running.
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const soonestSlots = await prisma.slotOfAppointment.findMany({
    where: {
      deletedAt: null,
      // B7 — a released (RESCHEDULED) slot keeps its original startsAt on an
      // APPROVED parent; without this guard it seeded "Today's Appointments"
      // with a session that no longer exists. Tentative holds belong to the
      // Requests tab, not the home calendar.
      completionStatus: "SCHEDULED",
      isTentative: false,
      endsAt: { gte: startOfToday },
      appointment: consultantAppointmentScope(consultantProfileId),
    },
    select: { appointmentId: true },
    orderBy: { startsAt: "asc" },
    take: HOME_APPOINTMENTS_TAKE * 5,
  });
  const homeAppointmentIds = [
    ...new Set(soonestSlots.map((s) => s.appointmentId)),
  ].slice(0, HOME_APPOINTMENTS_TAKE);

  // PERFORMANCE FIX #364: Use direct Prisma queries instead of internal HTTP fetches
  // This eliminates network overhead and reduces response time significantly
  const [
    appointmentsRaw,
    activeBookRows,
    pendingConsultations,
    pendingSubscriptions,
    pendingConsultationCount,
    pendingSubscriptionCount,
    recentActivities,
    earningsThisMonth,
    earningsLastMonth,
    ratingAgg,
    slotCounts,
    trialCounts,
    netEarningsAgg,
    readyEarningsAgg,
  ] = await Promise.all([
    // Fetch approved appointments for consultations, subscriptions, webinars, and
    // classes. `appointmentInclude` carries nine nested `user` selections, so an
    // unguarded empty id list cost nine follow-up SELECTs — see readByIds. The
    // guard is per-query, not an early return: every other read below is
    // consultant-scoped rather than id-scoped and must still run. (#1121)
    readByIds(homeAppointmentIds, () =>
      prisma.appointment.findMany({
        where: { id: { in: homeAppointmentIds } },
        include: appointmentInclude,
      }),
    ),
    // Active clients / programs are counted over the consultant's whole active
    // book, not the handful of rows Home renders. Deriving them from the
    // display array meant the Financial Summary card under-reported for anyone
    // with more appointments than the page shows. Ids only — no include graph.
    prisma.appointment.findMany({
      where: {
        ...consultantAppointmentScope(consultantProfileId),
        AND: [
          {
            slotsOfAppointment: {
              some: { deletedAt: null, startsAt: { gte: ninetyDaysAgo } },
            },
          },
          {
            slotsOfAppointment: {
              some: {
                deletedAt: null,
                completionStatus: { notIn: ["COMPLETED", "CANCELLED"] },
              },
            },
          },
        ],
      },
      select: {
        consultation: { select: { requestedBy: { select: { id: true } } } },
        subscription: {
          select: { id: true, requestedBy: { select: { id: true } } },
        },
        class: { select: { id: true } },
      },
    }),
    // Fetch pending consultations
    prisma.consultation.findMany({
      where: {
        consultationPlan: {
          consultantProfile: {
            id: consultantProfileId,
          },
        },
        status: "PENDING",
        // TTFB bound: approvals widget surfaces actionable recent requests;
        // a 90-day-old PENDING request is stale.
        requestedAt: { gte: ninetyDaysAgo },
      },
      include: pendingConsultationInclude,
      orderBy: {
        requestedAt: "desc",
      },
      take: HOME_PENDING_TAKE,
    }),
    // Fetch pending subscriptions
    prisma.subscription.findMany({
      where: {
        subscriptionPlan: {
          consultantProfileId,
        },
        status: "PENDING",
        // TTFB bound: approvals widget surfaces actionable recent requests;
        // a 90-day-old PENDING request is stale.
        requestedAt: { gte: ninetyDaysAgo },
      },
      include: pendingSubscriptionInclude,
      orderBy: {
        requestedAt: "desc",
      },
      take: HOME_PENDING_TAKE,
    }),
    // The approvals badge is a total, not a list length. Counting the capped
    // list made it disagree with NeedsYou — which counts properly — on the very
    // same screen once a consultant had more pending requests than the cap.
    //
    // Deliberately unbounded by date, unlike the list above. NeedsYou counts
    // every pending request regardless of age, and these two numbers render
    // inches apart, so matching its definition is what stops them contradicting
    // each other. The 90-day bound stays on the list, which is only a preview.
    //
    // #1345 — and the predicate itself is NeedsYou's, not a re-typed copy. Home
    // is a personal (B2C) surface like PERSONAL_ORG_PIN below, so an org-funded
    // pending request belongs to that org's dashboard and must not inflate this
    // badge while the card underneath it excludes the same row.
    prisma.consultation.count({
      where: pendingConsultationWhere(consultantProfileId, {
        kind: "personal",
      }),
    }),
    prisma.subscription.count({
      where: pendingSubscriptionWhere(consultantProfileId, {
        kind: "personal",
      }),
    }),
    // Fetch recent activities
    prisma.activityLog.findMany({
      where: {
        consultantProfileId,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 10,
    }),
    // --- Performance Snapshot Queries ---
    // 1a. Earnings this month (consultant share from ConsultantEarnings, excluding refunded, minus partial refunds)
    // #1166 ORG-2 — personal (B2C) only, the same filter the Earnings tab
    // applies (lib/data/consultant-earnings-analytics.ts), so Home and
    // Earnings show the same number.
    prisma.consultantEarnings.aggregate({
      _sum: { consultantSharePaise: true, refundedShareAmount: true },
      where: {
        consultantProfileId,
        status: { not: "REFUNDED" },
        createdAt: { gte: startOfMonth },
        payment: { ...PERSONAL_ORG_PIN },
      },
    }),
    // 1b. Earnings last month
    prisma.consultantEarnings.aggregate({
      _sum: { consultantSharePaise: true, refundedShareAmount: true },
      where: {
        consultantProfileId,
        status: { not: "REFUNDED" },
        createdAt: { gte: startOfLastMonth, lt: startOfMonth },
        payment: { ...PERSONAL_ORG_PIN },
      },
    }),
    // 2. Average rating
    prisma.consultantReview.aggregate({
      _avg: { rating: true },
      _count: { rating: true },
      // #693 — mirror the moderation recalc: removed reviews don't count
      where: { consultantProfileId, deletedAt: null },
    }),
    // 3. Session completion rate (last 30 days)
    prisma.slotOfAppointment.groupBy({
      by: ["completionStatus"],
      _count: true,
      where: {
        appointment: {
          // #1166 ORG-1 — this predicate is rebuilt rather than shared with
          // consultantAppointmentScope (different status rules), so the
          // personal pin has to be repeated or Home's completion rate counts
          // org sessions the rest of the page excludes.
          ...PERSONAL_ORG_PIN,
          OR: [
            { consultation: { consultationPlan: { consultantProfileId } } },
            { subscription: { subscriptionPlan: { consultantProfileId } } },
            { webinar: { webinarPlan: { consultantProfileId } } },
            { class: { classPlan: { consultantProfileId } } },
          ],
        },
        startsAt: { gte: thirtyDaysAgo, lt: now },
      },
    }),
    // 4. Trial conversion rate (90-day window)
    prisma.trialSession.groupBy({
      by: ["status"],
      _count: true,
      where: { consultantProfileId, createdAt: { gte: ninetyDaysAgo } },
    }),
    // --- Financial Summary Queries ---
    // Deliberately GLOBAL (no org filter): payouts settle one instrument
    // across every context (ADR 19 — views split, instruments don't).
    // 5. Net earnings (all-time, excluding refunded, minus partial refunds)
    prisma.consultantEarnings.aggregate({
      _sum: { consultantSharePaise: true, refundedShareAmount: true },
      where: {
        consultantProfileId,
        status: { not: "REFUNDED" },
      },
    }),
    // 6. Ready earnings (eligible for next payout — not yet assigned to a payout)
    prisma.consultantEarnings.aggregate({
      _sum: { consultantSharePaise: true, refundedShareAmount: true },
      where: {
        consultantProfileId,
        status: "READY",
        payoutId: null,
      },
    }),
  ]);

  // Sort appointments by slot start time (matching original API behavior)
  const sortedAppointments = appointmentsRaw.sort((a, b) => {
    const aTime = a.slotsOfAppointment?.[0]?.startsAt;
    const bTime = b.slotsOfAppointment?.[0]?.startsAt;

    if (!aTime && !bTime) return 0;
    if (!aTime) return 1;
    if (!bTime) return -1;

    return new Date(aTime).getTime() - new Date(bTime).getTime();
  });

  // Transform appointments (same logic as fetchHelpers.ts)
  const transformedAppointments = sortedAppointments.map(
    (appointment: DashboardAppointment) => ({
      id: appointment.id,
      appointmentType: appointment.appointmentType,
      // Org-funding marker — drives the "Sponsored · <Org>" badge on
      // the consultant Home + Appointments surfaces. Previously dropped
      // by this manual field-mapping transform.
      organizationId: appointment.organizationId,
      slotsOfAppointment: appointment.slotsOfAppointment.map((slot) => ({
        id: slot.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        isTentative: slot.isTentative,
        completionStatus: slot.completionStatus,
        meetingSession: slot.meetingSession ?? null,
        user: Array.isArray(slot.user)
          ? slot.user.map((u) => ({
              id: u.id,
              name: u.name,
              email: u.email,
              image: u.image,
            }))
          : [],
      })),
      consultation: appointment.consultation
        ? {
            id: appointment.consultation.id,
            consultationPlan: {
              ...appointment.consultation.consultationPlan,
              consultantProfile:
                appointment.consultation.consultationPlan.consultantProfile,
            },
            status: appointment.consultation.status,
            requestedBy: {
              id: appointment.consultation.requestedBy?.id ?? "",
              user: {
                name: appointment.consultation.requestedBy?.user?.name ?? null,
                image:
                  appointment.consultation.requestedBy?.user?.image ?? null,
              },
            },
          }
        : undefined,
      subscription: appointment.subscription
        ? {
            id: appointment.subscription.id,
            subscriptionPlan: {
              ...appointment.subscription.subscriptionPlan,
              consultantProfile:
                appointment.subscription.subscriptionPlan.consultantProfile,
            },
            status: appointment.subscription.status,
            requestedBy: {
              id: appointment.subscription.requestedBy?.id ?? "",
              user: {
                name: appointment.subscription.requestedBy?.user?.name ?? null,
                image:
                  appointment.subscription.requestedBy?.user?.image ?? null,
              },
            },
            startDate: new Date(
              appointment.subscription.schedulingPeriodStartsAt,
            ).toISOString(),
            endDate: new Date(
              appointment.subscription.schedulingPeriodEndsAt,
            ).toISOString(),
          }
        : undefined,
      webinar: appointment.webinar
        ? {
            id: appointment.webinar.id,
            webinarPlan: {
              ...appointment.webinar.webinarPlan,
              consultantProfile:
                appointment.webinar.webinarPlan.consultantProfile,
              collaborators:
                appointment.webinar.webinarPlan.collaborators ?? [],
            },
            status: appointment.webinar.status,
          }
        : undefined,
      class: appointment.class
        ? {
            id: appointment.class.id,
            classPlan: {
              ...appointment.class.classPlan,
              consultantProfile: appointment.class.classPlan.consultantProfile,
              collaborators: appointment.class.classPlan.collaborators ?? [],
            },
            status: appointment.class.status,
          }
        : undefined,
    }),
  );

  // Transform approvals (same logic as fetchHelpers.ts)
  const consultationApprovals = pendingConsultations.map(
    (consultation: DashboardConsultation) => ({
      id: consultation.id,
      type: "Consultation",
      name: consultation.requestedBy?.user?.name ?? "Unknown",
      requestedAt: consultation.requestedAt,
    }),
  );

  const subscriptionApprovals = pendingSubscriptions.map(
    (subscription: DashboardSubscription) => ({
      id: subscription.id,
      type: "Subscription",
      name: subscription.requestedBy?.user?.name ?? "Unknown",
      requestedAt: subscription.requestedAt,
    }),
  );

  // Sort by requestedAt (ISO string) for type safety
  const sortedApprovals = [
    ...consultationApprovals,
    ...subscriptionApprovals,
  ].sort(
    (a, b) =>
      new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime(),
  );

  // Map to display format for response
  const approvals = sortedApprovals.map((approval) => ({
    id: approval.id,
    type: approval.type,
    name: approval.name,
    date: formatDate(approval.requestedAt),
    time: formatTime(approval.requestedAt),
  }));

  // Total pending requests, independent of how many the widget lists.
  const pendingRequestsCount =
    pendingConsultationCount + pendingSubscriptionCount;

  // Transform activities for display
  const activities = recentActivities.map((activity) => ({
    id: activity.id,
    type: activity.activityType,
    description: activity.description,
    actorId: activity.actorId,
    actorName: activity.actorName,
    actorImage: activity.actorImage,
    metadata: activity.metadata,
    createdAt: activity.createdAt,
    // Formatted time for display
    timeAgo: getRelativeTime(activity.createdAt),
  }));

  // --- Compute Performance Snapshot derived values ---
  // #780 — _sum bypasses the result extension: bigint until sumPaise'd.
  const earningsThisMonthVal =
    sumPaise(earningsThisMonth._sum.consultantSharePaise) -
    sumPaise(earningsThisMonth._sum.refundedShareAmount);
  const earningsLastMonthVal =
    sumPaise(earningsLastMonth._sum.consultantSharePaise) -
    sumPaise(earningsLastMonth._sum.refundedShareAmount);

  // Earnings trend: percentage change (guard against division by zero)
  const earningsTrend =
    earningsLastMonthVal > 0
      ? Math.round(
          ((earningsThisMonthVal - earningsLastMonthVal) /
            earningsLastMonthVal) *
            100,
        )
      : earningsThisMonthVal > 0
        ? 100
        : 0;

  // Session completion rate from slot counts
  const slotCountMap = new Map(
    slotCounts.map((s) => [s.completionStatus, s._count]),
  );
  const completedSlots = slotCountMap.get("COMPLETED") ?? 0;
  const cancelledSlots = slotCountMap.get("CANCELLED") ?? 0;
  const unverifiedSlots = slotCountMap.get("UNVERIFIED") ?? 0;
  const completionDenom = completedSlots + cancelledSlots + unverifiedSlots;
  const completionRate =
    completionDenom > 0
      ? Math.round((completedSlots / completionDenom) * 100)
      : null;

  // Trial conversion rate
  const trialCountMap = new Map(trialCounts.map((t) => [t.status, t._count]));
  const completedTrials = trialCountMap.get("COMPLETED") ?? 0;
  const convertedTrials = trialCountMap.get("CONVERTED") ?? 0;
  const trialDenom = completedTrials + convertedTrials;
  const trialConversionRate =
    trialDenom > 0 ? Math.round((convertedTrials / trialDenom) * 100) : null;

  // --- Financial Summary derived values ---
  const netEarningsVal =
    sumPaise(netEarningsAgg._sum.consultantSharePaise) -
    sumPaise(netEarningsAgg._sum.refundedShareAmount);
  const readyEarningsVal =
    sumPaise(readyEarningsAgg._sum.consultantSharePaise) -
    sumPaise(readyEarningsAgg._sum.refundedShareAmount);
  const payoutMinimum = PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT;
  const payoutEligible = readyEarningsVal >= payoutMinimum;

  // Active clients + programs: single pass over the full active book. The
  // query already excludes fully completed/cancelled appointments, so every
  // row here counts.
  const activeClientIds = new Set<string>();
  const activeSubIds = new Set<string>();
  const activeClassIds = new Set<string>();
  for (const apt of activeBookRows) {
    const consulteeId =
      apt.consultation?.requestedBy?.id ?? apt.subscription?.requestedBy?.id;
    if (consulteeId) activeClientIds.add(consulteeId);
    if (apt.subscription?.id) activeSubIds.add(apt.subscription.id);
    if (apt.class?.id) activeClassIds.add(apt.class.id);
  }

  const financialSummary = {
    netEarnings: netEarningsVal,
    nextPayout: readyEarningsVal,
    payoutStatus: payoutEligible
      ? "Ready"
      : readyEarningsVal > 0
        ? `₹${(readyEarningsVal / 100).toLocaleString("en-IN")} / ₹${(PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT / 100).toLocaleString("en-IN")}`
        : "No ready earnings yet",
    activeClients: activeClientIds.size,
    activePrograms: activeSubIds.size + activeClassIds.size,
  };

  // toPlain — transformedAppointments spreads the four money-extended plan
  // rows (consultation/subscription/webinar/classPlan, each carries an
  // inspect symbol via the #780/#781 result extension), so the payload must
  // be plainified before it crosses the RSC→Client HydrationBoundary. The
  // route path (NextResponse.json) was always fine — JSON drops symbols —
  // so this only matters for the SSR prefetch. Preserves Dates as Dates.
  return toPlain({
    appointments: transformedAppointments,
    activities,
    approvals,
    pendingRequestsCount,
    performanceSnapshot: {
      earningsThisMonth: earningsThisMonthVal,
      earningsLastMonth: earningsLastMonthVal,
      earningsTrend,
      completionRate,
      averageRating: ratingAgg._avg.rating ?? 0,
      totalReviews: ratingAgg._count.rating,
      trialConversionRate,
    },
    financialSummary,
  }) as unknown as TConsultantDashboardResponse;
}
