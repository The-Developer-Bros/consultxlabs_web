import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { SubscriptionPlanSchema } from "@/schemas/plans";
import {
  curriculumCreateNested,
  faqReplaceNested,
} from "@/lib/api/plans/content";
import { findOrCreateTopics, transformTopicsToStrings } from "@/lib/topics";
import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";
import { getMinTrialPriceInPaise } from "@/lib/trials/pricing-config";
import {
  archivedAtForArchive,
  parsePlanArchiveBody,
  PLAN_ORG_GOVERNED_RESPONSE,
  PLAN_ARCHIVE_RESPONSE_NOTE,
} from "@/lib/api/plans/archive";

import { getSession } from "@/lib/auth-server";
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionPlanId: string }> },
) {
  try {
    const { subscriptionPlanId } = await params;
    const subscriptionPlan = await prisma.subscriptionPlan.findUniqueOrThrow({
      where: { id: subscriptionPlanId },
      include: {
        consultantProfile: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                workExperiences: {
                  select: { company: true, companyDomain: true, isCurrent: true },
                  orderBy: [{ isCurrent: "desc" as const }, { startDate: "desc" as const }],
                  take: 3,
                },
              },
            },
          },
        },
        subscriptions: {
          include: {
            requestedBy: {
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
          },
        },
        topics: true,
        faqs: { orderBy: { order: "asc" } },
        subscriptionContents: {
          orderBy: { order: "asc" },
        },
      },
    });

    return NextResponse.json(
      { data: transformTopicsToStrings(subscriptionPlan) },
      { status: 200 },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "plans" } });
    console.error("Error fetching subscription plan:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the subscription plan" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionPlanId: string }> },
) {
  try {
    // Authentication check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const { subscriptionPlanId } = await params;

    // Verify ownership - user must own this subscription plan
    const existingPlan = await prisma.subscriptionPlan.findUnique({
      where: { id: subscriptionPlanId },
      include: { consultantProfile: true },
    });

    if (!existingPlan) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }

    if (existingPlan.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        {
          error: "You do not have permission to update this subscription plan",
        },
        { status: 403 },
      );
    }

    const body = await request.json();

    // Validate input with Zod schema (partial for updates)
    const validationResult = SubscriptionPlanSchema.partial().safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        { error: "Validation failed", details: validationResult.error.issues },
        { status: 400 },
      );
    }

    const validatedData = validationResult.data;

    // Recompute derived metrics if base fields are being updated
    let totalSessions: number | undefined;
    let totalHours: number | undefined;

    if (
      validatedData.sessionsPerWeek !== undefined ||
      validatedData.durationInMonths !== undefined ||
      body.sessionDurationInHours !== undefined
    ) {
      const sessionsPerWeek =
        validatedData.sessionsPerWeek ?? existingPlan.sessionsPerWeek;
      const durationInMonths =
        validatedData.durationInMonths ?? existingPlan.durationInMonths;
      const sessionDurationInHours =
        body.sessionDurationInHours ?? existingPlan.sessionDurationInHours;

      // Use accurate week counting instead of fixed * 4 approximation
      const metricStartDate = new Date();
      metricStartDate.setHours(0, 0, 0, 0);
      const metricEndDate = new Date(metricStartDate);
      metricEndDate.setMonth(metricEndDate.getMonth() + durationInMonths);
      const estimatedWeeks = SlotCalculationService.countWeeks(
        metricStartDate,
        metricEndDate,
      );
      totalSessions = sessionsPerWeek * estimatedWeeks;
      totalHours = totalSessions * sessionDurationInHours;
    }

    // Floor check on the effective post-update trial price. Untouched
    // plans are never retro-policed — only edits that set a price or
    // newly enable the trial run against the platform floor.
    const effectiveTrialEnabled =
      validatedData.trialEnabled ?? existingPlan.trialEnabled;
    if (
      effectiveTrialEnabled &&
      (validatedData.trialPriceInPaise !== undefined ||
        validatedData.trialEnabled === true)
    ) {
      const effectivePrice =
        validatedData.trialPriceInPaise ?? existingPlan.trialPriceInPaise;
      const floor = await getMinTrialPriceInPaise();
      if (effectivePrice < floor) {
        return NextResponse.json(
          { error: `Trial price must be at least ₹${floor / 100}` },
          { status: 400 },
        );
      }
    }

    // Handle topics if provided
    let topicsUpdate = {};
    if (validatedData.topics !== undefined) {
      const topicIds = await findOrCreateTopics(validatedData.topics);
      topicsUpdate = {
        topics: { set: topicIds.map((id) => ({ id })) },
      };
    }

    // Handle subscription contents (roadmap) if provided
    const subscriptionContents = body.subscriptionContents as
      | Array<{
          id?: string;
          title: string;
          description: string;
          contentType?: string;
          contentUrl?: string;
          order: number;
          hoursAllotted?: number;
          sectionLabel?: string | null;
          outcomes?: string[];
        }>
      | undefined;

    // Use transaction to ensure atomicity when updating subscription contents
    // This prevents data loss if the update fails after deleting old contents
    const subscriptionPlan = await prisma.$transaction(async (tx) => {
      // If subscriptionContents is provided, delete existing and create new ones
      if (subscriptionContents !== undefined) {
        await tx.subscriptionContent.deleteMany({
          where: { subscriptionPlanId },
        });
      }

      return tx.subscriptionPlan.update({
        where: { id: subscriptionPlanId },
        data: {
          title: validatedData.title,
          description: validatedData.description,
          durationInMonths: validatedData.durationInMonths,
          price:
            validatedData.price !== undefined
              ? Math.round(validatedData.price)
              : undefined,
          priceCurrency: validatedData.priceCurrency,
          sessionsPerWeek: validatedData.sessionsPerWeek,
          sessionDurationInHours: body.sessionDurationInHours,
          totalSessions,
          totalHours,
          emailSupport: validatedData.emailSupport,
          language: validatedData.language,
          level: validatedData.level,
          prerequisites: validatedData.prerequisites,
          materialProvided: validatedData.materialProvided,
          learningOutcomes: validatedData.learningOutcomes,
          subtitle: validatedData.subtitle,
          targetAudience: validatedData.targetAudience,
          whatsIncluded: validatedData.whatsIncluded,
          faqs: faqReplaceNested(validatedData.faqs),
          recordingEnabled: validatedData.recordingEnabled,
          recordingStoragePolicy: validatedData.recordingStoragePolicy,
          trialEnabled: validatedData.trialEnabled,
          trialDurationMinutes: validatedData.trialDurationMinutes,
          trialPriceInPaise: validatedData.trialPriceInPaise,
          ...topicsUpdate,
          subscriptionContents:
            subscriptionContents !== undefined
              ? {
                  create: curriculumCreateNested(
                    subscriptionContents.map((c) => ({
                      ...c,
                      hoursAllotted: c.hoursAllotted ?? 1.0,
                    })),
                  ).create,
                }
              : undefined,
        },
        include: {
          consultantProfile: {
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
          subscriptions: {
            include: {
              requestedBy: {
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
            },
          },
          topics: true,
          faqs: { orderBy: { order: "asc" } },
          subscriptionContents: {
            orderBy: { order: "asc" },
          },
        },
      });
    });

    return NextResponse.json(
      { data: transformTopicsToStrings(subscriptionPlan) },
      { status: 200 },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "plans" } });
    console.error("Error updating subscription plan:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the subscription plan" },
      { status: 500 },
    );
  }
}

/**
 * Sole-owner archive/restore (#1494) — a consultant stops selling a
 * subscription offering without the org-catalog bulk-archive path.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionPlanId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const { subscriptionPlanId } = await params;

    const parsedBody = await parsePlanArchiveBody(request);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.error, details: parsedBody.details },
        { status: 400 },
      );
    }
    const { archived } = parsedBody;

    const existingPlan = await prisma.subscriptionPlan.findUnique({
      where: { id: subscriptionPlanId },
      include: { consultantProfile: true },
    });

    if (!existingPlan) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }

    if (existingPlan.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        {
          error: "You do not have permission to update this subscription plan",
        },
        { status: 403 },
      );
    }

    if (existingPlan.organizationId) {
      return NextResponse.json(PLAN_ORG_GOVERNED_RESPONSE, { status: 403 });
    }

    const subscriptionPlan = await prisma.subscriptionPlan.update({
      where: { id: subscriptionPlanId },
      data: {
        archivedAt: archived
          ? archivedAtForArchive(existingPlan.archivedAt)
          : null,
      },
    });

    return NextResponse.json(
      {
        data: { id: subscriptionPlan.id, archivedAt: subscriptionPlan.archivedAt },
        message: PLAN_ARCHIVE_RESPONSE_NOTE,
      },
      { status: 200 },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "plans" } });
    console.error("Error archiving subscription plan:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the subscription plan" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionPlanId: string }> },
) {
  try {
    // Authentication check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const { subscriptionPlanId } = await params;

    // Verify ownership - user must own this subscription plan
    const existingPlan = await prisma.subscriptionPlan.findUnique({
      where: { id: subscriptionPlanId },
      include: { consultantProfile: true },
    });

    if (!existingPlan) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }

    if (existingPlan.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        {
          error: "You do not have permission to delete this subscription plan",
        },
        { status: 403 },
      );
    }

    // Check if there are any associated subscriptions
    const associatedSubscriptions = await prisma.subscription.findMany({
      where: { subscriptionPlanId },
    });

    if (associatedSubscriptions.length > 0) {
      return NextResponse.json(
        {
          error:
            "Cannot delete subscription plan with associated subscriptions",
        },
        { status: 400 },
      );
    }

    const subscriptionPlan = await prisma.subscriptionPlan.delete({
      where: { id: subscriptionPlanId },
      include: {
        consultantProfile: {
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
        topics: true,
      },
    });

    return NextResponse.json(
      { data: transformTopicsToStrings(subscriptionPlan) },
      { status: 200 },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "plans" } });
    console.error("Error deleting subscription plan:", error);
    return NextResponse.json(
      { error: "An error occurred while deleting the subscription plan" },
      { status: 500 },
    );
  }
}
