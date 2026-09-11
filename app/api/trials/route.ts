import prisma from "@/lib/prisma";
import { blocksNewTrialRequest } from "@/lib/trials/eligibility";
import { Prisma, TrialSessionStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { logTrialRequested } from "@/lib/activity/log-activity";
import { notifyTrialSessionRequested } from "@/lib/novu";
import { CreateTrialSchema } from "@/schemas/trials";
import { getSession } from "@/lib/auth-server";
import { trialRequestLimiter, applyRateLimit } from "@/lib/rate-limit";
import { resolveOrgScope, scopeToWhereOrgId } from "@/lib/api/scope/parse";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { consultantPublicScalars } from "@/lib/data/consultant-public";

/**
 * GET /api/trials
 * List trial sessions with optional filters
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const consultantProfileId = searchParams.get("consultantProfileId");
  const consulteeProfileId = searchParams.get("consulteeProfileId");
  const subscriptionPlanId = searchParams.get("subscriptionPlanId");
  const status = searchParams.get("status") as TrialSessionStatus | null;
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "10");
  const search = searchParams.get("search");
  const sortBy = searchParams.get("sortBy") || "requestedAt";
  const sortOrder = searchParams.get("sortOrder") || "desc";

  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const isPrivileged =
      session.user.role === "ADMIN" || session.user.role === "STAFF";

    // #org-appts — profile ids are carried independently of the singular
    // platform role, so a dual-profile user (e.g. a host EXPERT whose
    // marketplace role is CONSULTEE) must see a trial whether they are its
    // consultee OR its delivering consultant. Trials stay B2C: this is a pure
    // ownership union, never org-scoped. When neither side is requested via an
    // explicit `?consultant/consulteeProfileId=`, we fall back to the union of
    // whichever profiles the caller holds (built below as an OR).
    let applyOwnershipOr = false;
    if (!isPrivileged) {
      if (
        !session.user.consultantProfileId &&
        !session.user.consulteeProfileId
      ) {
        return NextResponse.json(
          {
            error:
              "No consultant or consultee profile configured. Please complete onboarding.",
          },
          { status: 422 },
        );
      }
      // Explicit profile-id filters stay locked to the caller's own ids.
      if (
        consultantProfileId &&
        consultantProfileId !== session.user.consultantProfileId
      ) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (
        consulteeProfileId &&
        consulteeProfileId !== session.user.consulteeProfileId
      ) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      // No explicit side requested → union both identities the caller holds.
      applyOwnershipOr = !consultantProfileId && !consulteeProfileId;
    }

    // #674 org-scope filter. TrialSession.organizationId is populated by
    // the backfill — keeps Acme-context views from leaking Zeta trial
    // bookings into the consultant's "Trials" tab.
    const callerMemberships = await prisma.membership.findMany({
      where: { userId: session.user.id, status: "ACTIVE" },
      select: { organizationId: true, status: true, role: true },
    });
    const scopeResolution = resolveOrgScope({
      raw: searchParams.get("orgScope"),
      memberships: callerMemberships,
      userRole: session.user.role,
      userId: session.user.id,
      // Non-admin callers are already locked to their own
      // consultant/consulteeProfileId (lines 50-73), so `?orgScope=all`
      // means "all of MY trials" — safe for any role.
      allowAllForOwner: true,
    });
    if (!scopeResolution.ok) {
      return NextResponse.json(
        { error: scopeResolution.message, code: scopeResolution.code },
        { status: scopeResolution.status },
      );
    }

    // #674 B2B gap 9 — `orgMember` pins an org too: it is what an active
    // member below `operations.read` resolves to. Testing `kind === "org"`
    // alone dropped them into the unfiltered arm, so asking for one org's
    // trials returned every org's plus the personal ones. scopeToWhereOrgId is
    // the single place that knows which kinds pin.
    const whereClause: Prisma.TrialSessionWhereInput = scopeToWhereOrgId(
      scopeResolution.scope,
    );

    if (applyOwnershipOr) {
      // #org-appts — dual-identity union; AND-nested so it composes with the
      // search OR below without clobbering it.
      const ownershipArms: Prisma.TrialSessionWhereInput[] = [];
      if (session.user.consultantProfileId) {
        ownershipArms.push({
          consultantProfileId: session.user.consultantProfileId,
        });
      }
      if (session.user.consulteeProfileId) {
        ownershipArms.push({
          consulteeProfileId: session.user.consulteeProfileId,
        });
      }
      whereClause.AND = [{ OR: ownershipArms }];
    } else {
      if (consultantProfileId) {
        whereClause.consultantProfileId = consultantProfileId;
      }

      if (consulteeProfileId) {
        whereClause.consulteeProfileId = consulteeProfileId;
      }
    }

    if (subscriptionPlanId) {
      whereClause.subscriptionPlanId = subscriptionPlanId;
    }

    if (status) {
      whereClause.status = status;
    }

    if (search) {
      whereClause.OR = [
        {
          consulteeProfile: {
            user: { name: { contains: search, mode: "insensitive" } },
          },
        },
        {
          consulteeProfile: {
            user: { email: { contains: search, mode: "insensitive" } },
          },
        },
      ];
    }

    // Dynamic orderBy mapping
    const orderByMap: Record<
      string,
      Prisma.TrialSessionOrderByWithRelationInput
    > = {
      requestedAt: { requestedAt: sortOrder as "asc" | "desc" },
      status: { status: sortOrder as "asc" | "desc" },
      name: {
        consulteeProfile: { user: { name: sortOrder as "asc" | "desc" } },
      },
      plan: { subscriptionPlan: { title: sortOrder as "asc" | "desc" } },
    };
    const orderBy = orderByMap[sortBy] || orderByMap.requestedAt;

    const [trialSessions, total] = await Promise.all([
      prisma.trialSession.findMany({
        where: whereClause,
        include: {
          consulteeProfile: {
            include: {
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
          subscriptionPlan: true,
          appointment: {
            include: {
              slotsOfAppointment: true,
            },
          },
          convertedToSubscription: true,
        },
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.trialSession.count({ where: whereClause }),
    ]);

    return NextResponse.json({
      data: trialSessions,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching trial sessions:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching trial sessions" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/trials
 * Request a new trial session
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const result = CreateTrialSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }
    const {
      consulteeProfileId,
      consultantProfileId,
      subscriptionPlanId,
      notes,
      organizationId,
    } = result.data;

    const isPrivileged =
      session.user.role === "ADMIN" || session.user.role === "STAFF";
    if (!isPrivileged) {
      if (
        session.user.role !== "CONSULTEE" ||
        session.user.consulteeProfileId !== consulteeProfileId
      ) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    // Rate limit: 3 trial requests per 24 hours per creator. #831 — applied
    // uniformly: a privileged session can still flood consultant inboxes,
    // so role no longer bypasses the limiter.
    const rl = await applyRateLimit(trialRequestLimiter, session.user.id);
    if (rl) return rl;

    // Check if a trial already exists for this consultee-consultant pair
    const existingTrial = await prisma.trialSession.findUnique({
      where: {
        consulteeProfileId_consultantProfileId: {
          consulteeProfileId,
          consultantProfileId,
        },
      },
    });

    // Only a live or already-delivered trial blocks a new request. A declined,
    // withdrawn or lapsed-unpaid trial frees the pair — never paying isn't the
    // same as having used your trial. The freed row must be deleted rather than
    // left in place, because the pair is @@unique. See lib/trials/eligibility.ts
    // for the abuse trade-off and how to tighten it if this gets gamed.
    if (existingTrial) {
      if (blocksNewTrialRequest(existingTrial.status)) {
        return NextResponse.json(
          {
            error: "You have already requested a trial with this consultant",
            code: "TRIAL_ALREADY_REQUESTED",
          },
          { status: 409 },
        );
      }
      // deleteMany, not delete: two requests can both read the same freed row
      // and both try to clear it, and the loser of that race gets P2025 — which
      // escapes to the generic catch as a 500, before the create-side unique
      // violation below can turn it into the calm 409 this pair already has an
      // answer for. A count of 0 means somebody else freed it; either way the
      // slot is clear and the insert decides who gets it.
      await prisma.trialSession.deleteMany({ where: { id: existingTrial.id } });
    }

    // Verify the subscription plan exists and has trials enabled
    const subscriptionPlan = await prisma.subscriptionPlan.findUnique({
      where: { id: subscriptionPlanId },
      include: {
        consultantProfile: {
          include: {
            user: true,
          },
        },
      },
    });

    if (!subscriptionPlan) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }

    if (subscriptionPlan.consultantProfileId !== consultantProfileId) {
      return NextResponse.json(
        { error: "Subscription plan does not belong to this consultant" },
        { status: 400 },
      );
    }

    if (!subscriptionPlan.trialEnabled) {
      return NextResponse.json(
        { error: "A trial is not available for this plan" },
        { status: 400 },
      );
    }

    // Paid trials are wired: no money moves at request time. The consultant
    // accepts first, which mints the pay-link and puts the trial in
    // AWAITING_PAYMENT — so a declined request never needs a refund.
    // Get consultee info for activity log
    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { id: consulteeProfileId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
    });

    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    // Enterprise: if the caller passed `organizationId`, verify they're
    // an ACTIVE LEARNER (or higher) member of that org before we stamp
    // attribution. This is org-tagging for analytics (conversion-rate
    // per org) — never a payment claim. Silently
    // dropping the field on membership mismatch would let a curious
    // user forge org-tagged trial attribution; we return 403 instead so
    // the client bug becomes obvious. `findFirst` with `userId`
    // resolves against the BetterAuth User id on the session.
    let resolvedOrgId: string | null = null;
    if (organizationId) {
      const membership = await prisma.membership.findFirst({
        where: {
          organizationId,
          userId: session.user.id,
          status: "ACTIVE",
        },
        select: { id: true },
      });
      if (!membership) {
        return NextResponse.json(
          {
            error:
              "You are not an active member of the specified organization.",
          },
          { status: 403 },
        );
      }
      resolvedOrgId = organizationId;
    }

    // Create the trial session. The pair is @@unique, and the free-the-slot
    // delete above is a separate statement, so two concurrent requests for the
    // same pair both pass the eligibility read and race into the insert — the
    // loser used to surface as a 500. It is the same "already requested"
    // answer the sequential path gives, so say so.
    const trialSession = await prisma.trialSession
      .create({
        data: {
          consulteeProfileId,
          consultantProfileId,
          subscriptionPlanId,
          notes,
          status: TrialSessionStatus.PENDING,
          organizationId: resolvedOrgId,
        },
        include: {
          consulteeProfile: {
            include: {
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
          subscriptionPlan: true,
        },
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) return null;
        throw error;
      });

    if (!trialSession) {
      return NextResponse.json(
        {
          error: "You have already requested a trial with this consultant",
          code: "TRIAL_ALREADY_REQUESTED",
        },
        { status: 409 },
      );
    }

    // Log the activity
    await logTrialRequested(
      consultantProfileId,
      trialSession.id,
      {
        id: consulteeProfile.user.id,
        name: consulteeProfile.user.name,
        image: consulteeProfile.user.image,
      },
      subscriptionPlan.title,
    );

    // Notify the consultant about the new trial request
    void notifyTrialSessionRequested(trialSession.consultantProfile.user.id, {
      consultantName: trialSession.consultantProfile.user.name || "Consultant",
      consulteeName: trialSession.consulteeProfile.user.name || "User",
      planTitle: subscriptionPlan.title,
      status: trialSession.status,
      dashboardUrl: "/dashboard/consultant/trials",
    });

    return NextResponse.json({ data: trialSession }, { status: 201 });
  } catch (error) {
    console.error("Error creating trial session:", error);
    return NextResponse.json(
      { error: "An error occurred while creating trial session" },
      { status: 500 },
    );
  }
}
