import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "lib/prisma";
import { getSession } from "@/lib/auth-server";
import { bookingOrgId, getDmChannelId } from "@/lib/stream-utils";
import {
  dmEligibleStatusFilter,
  OPENABLE_EVENT_STATUSES,
} from "@/lib/stream/dm-eligibility-statuses";
import {
  AppointmentSearchResultSchema,
  type AppointmentSearchResult,
} from "@/schemas/stream-search";

/**
 * The OTHER party, relative to whoever is signed in.
 *
 * Every row used to be labelled with the consultant, unconditionally. That is
 * right on a consultee's dashboard and wrong on a consultant's, where it names
 * the viewer — so a consultant searching two letters of their own name got back
 * what looked like a conversation with themselves, subtitled with the booking
 * kinds they hold. The channel id underneath was always correct and always
 * pointed at the real consultee; only the label lied.
 */
function resolveCounterparty(
  viewerUserId: string,
  consultant: { id: string; name: string | null; image: string | null },
  consultee: { id: string; name: string | null; image: string | null },
): {
  counterpartyUserId: string;
  counterpartyName: string;
  counterpartyImage?: string;
} {
  const other = consultant.id === viewerUserId ? consultee : consultant;
  return {
    counterpartyUserId: other.id,
    counterpartyName: other.name || "Unknown",
    counterpartyImage: other.image || undefined,
  };
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be logged in to search appointments" },
        { status: 401 },
      );
    }

    const userId = session.user.id;
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get("q")?.trim().toLowerCase();

    if (!query || query.length < 2) {
      return NextResponse.json([]);
    }

    const results: AppointmentSearchResult[] = [];

    // Search Consultations (by plan title OR consultant name)
    // The four searches are independent — none reads another's result — so they
    // are issued together and awaited once. Sequential awaits made every
    // keystroke pay the SUM of four round-trips to a remote database; this pays
    // the slowest one.
    //
    // Each query also gains a deterministic `orderBy`. With `take: 10` and no
    // ordering, Postgres returns an arbitrary ten of the matching rows and the
    // `slice(0, 20)` below then cuts a set that can differ between two identical
    // requests — the same search, run twice, returning different people.
    // Newest-first is both stable and the more useful order.

    const consultationsPromise = prisma.consultation.findMany({
      where: {
        AND: [
          {
            OR: [
              // Search by plan title
              {
                consultationPlan: {
                  title: {
                    contains: query,
                    mode: "insensitive",
                  },
                },
              },
              // Search by consultant name
              {
                consultationPlan: {
                  consultantProfile: {
                    user: {
                      name: {
                        contains: query,
                        mode: "insensitive",
                      },
                    },
                  },
                },
              },
              // Search by consultee name. Absent until now, so a consultant
              // could not find a conversation by their own client's name —
              // only by their own name or the plan title. On a consultant's
              // dashboard the consultant arm above matches THEMSELVES, which is
              // why searching a few letters of their own name returned a row
              // that looked like a self-conversation.
              {
                requestedBy: {
                  user: {
                    name: {
                      contains: query,
                      mode: "insensitive",
                    },
                  },
                },
              },
            ],
          },
          {
            status: {
              ...dmEligibleStatusFilter(),
            },
          },
          {
            OR: [
              // User is the consultee
              {
                requestedBy: {
                  userId: userId,
                },
              },
              // User is the consultant
              {
                consultationPlan: {
                  consultantProfile: {
                    userId: userId,
                  },
                },
              },
            ],
          },
        ],
      },
      include: {
        consultationPlan: {
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
        requestedBy: {
          include: {
            user: {
              select: { id: true, name: true, image: true },
            },
          },
        },
        // Needed to resolve which DM thread this hit belongs to.
        appointment: { select: { organizationId: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: 10,
    });

    const subscriptionsPromise = prisma.subscription.findMany({
      where: {
        AND: [
          {
            OR: [
              // Search by plan title
              {
                subscriptionPlan: {
                  title: {
                    contains: query,
                    mode: "insensitive",
                  },
                },
              },
              // Search by consultant name
              {
                subscriptionPlan: {
                  consultantProfile: {
                    user: {
                      name: {
                        contains: query,
                        mode: "insensitive",
                      },
                    },
                  },
                },
              },
              // Search by consultee name — see the consultation block.
              {
                requestedBy: {
                  user: {
                    name: {
                      contains: query,
                      mode: "insensitive",
                    },
                  },
                },
              },
            ],
          },
          {
            status: {
              ...dmEligibleStatusFilter(),
            },
          },
          {
            OR: [
              // User is the consultee
              {
                requestedBy: {
                  userId: userId,
                },
              },
              // User is the consultant
              {
                subscriptionPlan: {
                  consultantProfile: {
                    userId: userId,
                  },
                },
              },
            ],
          },
        ],
      },
      include: {
        subscriptionPlan: {
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
        requestedBy: {
          include: {
            user: {
              select: { id: true, name: true, image: true },
            },
          },
        },
        // Needed to resolve which DM thread this hit belongs to. Filtered to
        // org-tagged rows because `take: 1` truncates server-side, before
        // bookingOrgId can pick — an unfiltered `take: 1` on a mixed
        // subscription can hand back a personal row and resolve `null`.
        appointments: {
          where: { organizationId: { not: null } },
          select: { organizationId: true },
          // Deterministic, not just filtered: `take: 1` over an
          // unordered result can hand different callers different
          // rows if a subscription ever carries two org-tagged
          // appointments, which is the same divergence one layer down.
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 1,
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: 10,
    });

    const webinarsPromise = prisma.webinar.findMany({
      where: {
        AND: [
          {
            webinarPlan: {
              title: {
                contains: query,
                mode: "insensitive",
              },
            },
          },
          {
            status: {
              in: [...OPENABLE_EVENT_STATUSES],
            },
          },
          {
            OR: [
              // User is on an appointment slot
              {
                appointment: {
                  slotsOfAppointment: {
                    some: { user: { some: { id: userId } } },
                  },
                },
              },
              // User is the consultant
              {
                webinarPlan: {
                  consultantProfile: {
                    userId: userId,
                  },
                },
              },
            ],
          },
        ],
      },
      include: {
        webinarPlan: {
          include: {
            consultantProfile: {
              include: {
                user: {
                  select: {
                    name: true,
                    image: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: 10,
    });

    const classesPromise = prisma.class.findMany({
      where: {
        AND: [
          {
            classPlan: {
              title: {
                contains: query,
                mode: "insensitive",
              },
            },
          },
          {
            status: {
              in: [...OPENABLE_EVENT_STATUSES],
            },
          },
          {
            OR: [
              // User is on an appointment slot
              {
                appointments: {
                  some: {
                    slotsOfAppointment: {
                      some: { user: { some: { id: userId } } },
                    },
                  },
                },
              },
              // User is the consultant
              {
                classPlan: {
                  consultantProfile: {
                    userId: userId,
                  },
                },
              },
            ],
          },
        ],
      },
      include: {
        classPlan: {
          include: {
            consultantProfile: {
              include: {
                user: {
                  select: {
                    name: true,
                    image: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: 10,
    });

    const [consultations, subscriptions, webinars, classes] = await Promise.all(
      [
        consultationsPromise,
        subscriptionsPromise,
        webinarsPromise,
        classesPromise,
      ],
    );

    for (const consultation of consultations) {
      // One bad row must not take the whole search down.
      //
      // `getDmChannelId` throws on a self-pair — deliberately, because a
      // one-member DM is unusable and silently collapsing it was the original
      // bug. But it is called here inside a loop over query results, so a
      // single legacy self-booked row (checkout blocks these now; seeded and
      // pre-guard data may still hold them) throws past this handler and the
      // outer catch answers 500 for the ENTIRE search. The user sees "no
      // results" for every query that happens to match that row.
      if (
        consultation.consultationPlan.consultantProfile.user.id ===
        consultation.requestedBy.user.id
      ) {
        continue;
      }
      const organizationId = bookingOrgId(consultation);
      results.push({
        id: consultation.id,
        type: "consultation",
        name: consultation.consultationPlan.title,
        ...resolveCounterparty(
          userId,
          consultation.consultationPlan.consultantProfile.user,
          consultation.requestedBy.user,
        ),
        organizationId,
        // Funding context is part of the DM key, so a hit must resolve to the
        // SAME channel the creator made. Shared resolver, because reading only
        // the appointment sent org-hosted-plan bookings to a personal channel
        // that was never created — clicking the result opened an empty thread.
        channelId: getDmChannelId(
          consultation.consultationPlan.consultantProfile.user.id,
          consultation.requestedBy.user.id,
          organizationId,
        ),
      });
    }

    for (const subscription of subscriptions) {
      // Same self-pair guard as the consultation loop above.
      if (
        subscription.subscriptionPlan.consultantProfile.user.id ===
        subscription.requestedBy.user.id
      ) {
        continue;
      }
      const organizationId = bookingOrgId(subscription);
      results.push({
        id: subscription.id,
        type: "subscription",
        name: subscription.subscriptionPlan.title,
        ...resolveCounterparty(
          userId,
          subscription.subscriptionPlan.consultantProfile.user,
          subscription.requestedBy.user,
        ),
        organizationId,
        // Same resolver as createSubscriptionChannel.
        channelId: getDmChannelId(
          subscription.subscriptionPlan.consultantProfile.user.id,
          subscription.requestedBy.user.id,
          organizationId,
        ),
      });
    }

    for (const webinar of webinars) {
      if (webinar.webinarPlan.consultantProfile) {
        results.push({
          id: webinar.id,
          type: "webinar",
          name: webinar.webinarPlan.title,
          // A group event has no single counterparty, so the host stands in.
          counterpartyName:
            webinar.webinarPlan.consultantProfile.user.name || "Unknown",
          counterpartyImage:
            webinar.webinarPlan.consultantProfile.user.image || undefined,
          channelId: `webinar-${webinar.id}`,
        });
      }
    }

    for (const classItem of classes) {
      if (classItem.classPlan.consultantProfile) {
        results.push({
          id: classItem.id,
          type: "class",
          name: classItem.classPlan.title,
          counterpartyName:
            classItem.classPlan.consultantProfile.user.name || "Unknown",
          counterpartyImage:
            classItem.classPlan.consultantProfile.user.image || undefined,
          channelId: `class-${classItem.id}`,
        });
      }
    }

    // Sort results by name
    results.sort((a, b) => a.name.localeCompare(b.name));

    // Limit total results
    // Parse on the way out. The consumer derives its type from this same
    // schema, so validating here is what makes the two agree by construction
    // rather than by assertion — a field renamed in this handler fails at the
    // boundary instead of arriving as `undefined` in the search dropdown.
    return NextResponse.json(
      AppointmentSearchResultSchema.array().parse(results.slice(0, 20)),
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    console.error("Error searching appointments:", error);
    return NextResponse.json(
      { error: "Failed to search appointments" },
      { status: 500 },
    );
  }
}
