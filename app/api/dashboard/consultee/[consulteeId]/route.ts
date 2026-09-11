import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { scopeToWhereOrgId } from "@/lib/api/scope/parse";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth-server";

// =============================================================================
// Prisma Query Types - Derived from actual query shape for type safety
// =============================================================================

const userSelectFields = {
  id: true,
  name: true,
  email: true,
  image: true,
  role: true,
  phone: true,
} as const;

const consultationInclude = {
  consultationPlan: {
    include: {
      // #946 allowlist. A bare `include:` shipped the consultant's panNumber /
      // ibanOrAccount / swiftBic to the learner's own dashboard. The sibling
      // resources/route.ts already narrows this way; this file was missed.
      consultantProfile: {
        select: {
          ...consultantPublicScalars,
          user: { select: userSelectFields },
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
  appointment: {
    include: {
      slotsOfAppointment: {
        include: {
          user: {
            select: userSelectFields,
          },
        },
        orderBy: {
          startsAt: "asc" as const,
        },
      },
      payment: true,
    },
  },
} satisfies Prisma.ConsultationInclude;

const subscriptionInclude = {
  subscriptionPlan: {
    include: {
      consultantProfile: {
        select: {
          ...consultantPublicScalars,
          user: {
            select: userSelectFields,
          },
          domain: true,
          subDomains: true,
          tags: true,
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
  appointments: {
    include: {
      slotsOfAppointment: {
        include: {
          user: {
            select: userSelectFields,
          },
        },
      },
      payment: true,
    },
  },
} satisfies Prisma.SubscriptionInclude;

const webinarInclude = {
  webinarPlan: {
    include: {
      consultantProfile: {
        select: {
          ...consultantPublicScalars,
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
      topics: true,
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
              consulteeProfileId: true,
            },
          },
        },
      },
      payment: true,
    },
  },
} satisfies Prisma.WebinarInclude;

const classInclude = {
  classPlan: {
    include: {
      consultantProfile: {
        select: {
          ...consultantPublicScalars,
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
      classContents: {
        orderBy: {
          order: "asc" as const,
        },
      },
    },
  },
  appointments: {
    include: {
      slotsOfAppointment: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
              consulteeProfileId: true,
            },
          },
        },
      },
      payment: true,
    },
  },
} satisfies Prisma.ClassInclude;

// =============================================================================
// Route Handler
// =============================================================================

/**
 * #1166 ORG-4 — this is the personal (B2C) surface: org-funded sessions live
 * on the org dashboard (ADR 19). #674 defect 13 — the pin comes from the
 * shared scope projector rather than a literal repeated at each query, so the
 * definition of "personal" lives in one place for the whole platform.
 */
const PERSONAL_ORG_PIN = scopeToWhereOrgId({ kind: "personal" });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ consulteeId: string }> },
) {
  // Note: request parameter kept for Next.js API route signature compatibility
  void request;

  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const resolvedParams = await params;
    const { consulteeId } = resolvedParams;

    if (!consulteeId) {
      return NextResponse.json(
        { error: "Consultee ID is required" },
        { status: 400 },
      );
    }

    // Verify the consultee profile exists before fetching data
    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { id: consulteeId },
      select: { id: true },
    });

    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    const isPrivileged =
      session.user.role === "ADMIN" || session.user.role === "STAFF";
    const ownsProfile =
      session.user.role === "CONSULTEE" &&
      session.user.consulteeProfileId === consulteeId;

    if (!isPrivileged && !ownsProfile) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // PERFORMANCE FIX #364: Use direct Prisma queries instead of internal HTTP fetches
    // This eliminates network overhead and reduces response time significantly
    //
    // #1166 ORG-4 — personal surface: every query pins the appointment through
    // PERSONAL_ORG_PIN (ADR 19); mirrors lib/data/consultee-events-read.ts.
    //
    // take: per-user history is naturally small, but these were the only
    // unbounded findManys on the hottest dashboard read — cap them so a
    // pathological account (or an import bug) can't turn this endpoint into
    // a multi-MB payload.
    const PER_USER_TAKE = 250;
    const [consultations, subscriptions, webinars, classes] = await Promise.all(
      [
        // Fetch consultations for this consultee
        prisma.consultation.findMany({
          where: {
            requestedById: consulteeId,
            appointment: { is: PERSONAL_ORG_PIN },
          },
          include: consultationInclude,
          orderBy: {
            requestedAt: "desc",
          },
          take: PER_USER_TAKE,
        }),
        // Fetch subscriptions for this consultee
        prisma.subscription.findMany({
          where: {
            requestedById: consulteeId,
            appointments: { some: PERSONAL_ORG_PIN },
          },
          include: subscriptionInclude,
          orderBy: {
            requestedAt: "desc",
          },
          take: PER_USER_TAKE,
        }),
        // Webinars the consultee registered for
        prisma.webinar.findMany({
          where: {
            OR: [
              // Get webinars where consultee is registered through appointments
              {
                appointment: {
                  ...PERSONAL_ORG_PIN,
                  slotsOfAppointment: {
                    some: {
                      user: {
                        some: {
                          consulteeProfile: {
                            id: consulteeId,
                          },
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
          include: {
            ...webinarInclude,
          },
          // Deterministic truncation: take without orderBy is unspecified
          // order, so >250 matches could page differently between requests.
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: PER_USER_TAKE,
        }),
        // Classes the consultee enrolled in
        prisma.class.findMany({
          where: {
            OR: [
              // Get classes where consultee is registered through appointments
              {
                appointments: {
                  some: {
                    ...PERSONAL_ORG_PIN,
                    slotsOfAppointment: {
                      some: {
                        user: {
                          some: {
                            consulteeProfile: {
                              id: consulteeId,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
          include: {
            ...classInclude,
          },
          orderBy: [
            {
              schedulingPeriodStartsAt: "desc",
            },
            {
              status: "asc",
            },
          ],
          take: PER_USER_TAKE,
        }),
      ],
    );

    // Return consolidated response
    return NextResponse.json({
      success: true,
      data: {
        consultations: consultations || [],
        subscriptions: subscriptions || [],
        webinars: webinars || [],
        classes: classes || [],
      },
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "dashboard" } },
    );
    console.error("Error fetching consultee events:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch events data",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
