import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import {
  planCollaboratorConsultantSelect,
  planConsultantSelect,
} from "@/lib/api/plans/consultant-projection";
import {
  parsePlanFilters,
  buildPlanWhereClause,
  buildPlanOrderBy,
  paginatedResponse,
  rankAndPaginate,
} from "../shared/plan-filters";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const includeRegistration =
      searchParams.get("includeRegistration") === "true";

    const filters = parsePlanFilters(searchParams);
    const { sort, page, limit, skip } = filters;
    const where = buildPlanWhereClause(filters) as Prisma.WebinarPlanWhereInput;
    const orderBy = buildPlanOrderBy(sort) as
      | Prisma.WebinarPlanOrderByWithRelationInput
      | undefined;

    // Build include object based on whether registration data is requested
    const include: Record<string, unknown> = {
      consultantProfile: { select: planConsultantSelect },
      topics: true,
      collaborators: {
        where: { status: "ACCEPTED" },
        include: {
          consultantProfile: { select: planCollaboratorConsultantSelect },
        },
      },
    };

    if (includeRegistration) {
      include.webinars = {
        include: {
          appointment: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: { select: { id: true } },
                },
              },
            },
          },
        },
      };
    }

    // For trending sort, use a two-step Prisma approach:
    // 1. Lightweight select (IDs + nested slot IDs only) to rank by enrollment count
    // 2. Fetch full plan data only for the paginated slice
    if (sort === "trending") {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const plansForRanking = await prisma.webinarPlan.findMany({
        where,
        select: {
          id: true,
          webinars: {
            select: {
              appointment: {
                select: {
                  slotsOfAppointment: {
                    where: { createdAt: { gte: thirtyDaysAgo } },
                    select: { id: true },
                  },
                },
              },
            },
          },
        },
      });

      const ranked = plansForRanking
        .map((p) => ({
          id: p.id,
          count: p.webinars.reduce(
            (sum, w) => sum + (w.appointment?.slotsOfAppointment?.length ?? 0),
            0,
          ),
        }))
        .sort((a, b) => b.count - a.count);

      return rankAndPaginate(
        ranked,
        (ids) =>
          prisma.webinarPlan.findMany({
            where: { ...where, id: { in: ids } },
            include,
          }),
        skip,
        limit,
        page,
      );
    }

    const [webinarPlans, total] = await Promise.all([
      prisma.webinarPlan.findMany({
        where,
        include,
        skip,
        take: limit,
        ...(orderBy && { orderBy }),
      }),
      prisma.webinarPlan.count({ where }),
    ]);

    return paginatedResponse(webinarPlans, total, page, limit);
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("Error fetching webinar plans:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching webinar plans" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const body = await request.json();
    const {
      title,
      description,
      durationInHours,
      price,
      maxParticipants,
      language,
      level,
      prerequisites,
      materialProvided,
      learningOutcomes,
      topicIds,
      recordingEnabled,
      recordingStoragePolicy,
    } = body;

    // Ownership: non-privileged users can only create plans for themselves
    const consultantProfileId = isPrivileged(session.user.role)
      ? body.consultantProfileId
      : session.user.consultantProfileId;

    if (!consultantProfileId) {
      return forbiddenResponse(
        "You must have a consultant profile to create a webinar plan",
      );
    }

    // Input validation
    if (!title || !durationInHours || !price || !maxParticipants) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    if (durationInHours <= 0 || price <= 0 || maxParticipants <= 0) {
      return NextResponse.json(
        { error: "Invalid numeric values" },
        { status: 400 },
      );
    }

    const newWebinarPlan = await prisma.webinarPlan.create({
      data: {
        title,
        description,
        durationInHours,
        price,
        maxParticipants,
        language,
        level,
        prerequisites,
        materialProvided,
        learningOutcomes,
        recordingEnabled: recordingEnabled ?? false,
        recordingStoragePolicy: recordingStoragePolicy ?? "STREAM_ONLY",
        consultantProfile: { connect: { id: consultantProfileId } },
        topics: topicIds
          ? { connect: topicIds.map((id: string) => ({ id })) }
          : undefined,
      },
      include: {
        consultantProfile: {
          include: {
            user: {
              select: {
                name: true,
                image: true,
                workExperiences: {
                  select: {
                    company: true,
                    companyDomain: true,
                    isCurrent: true,
                  },
                  orderBy: [
                    { isCurrent: "desc" as const },
                    { startDate: "desc" as const },
                  ],
                  take: 3,
                },
              },
            },
          },
        },
        topics: true,
      },
    });

    return NextResponse.json({ data: newWebinarPlan }, { status: 201 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("Error creating webinar plan:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the webinar plan" },
      { status: 500 },
    );
  }
}
