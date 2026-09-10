import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { SubscriptionPlanSchema } from "@/schemas/plans";
import {
  curriculumCreateNested,
  faqCreateNested,
  planContentInclude,
} from "@/lib/api/plans/content";
import { findOrCreateTopics, transformTopicsToStrings } from "@/lib/topics";
import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";
import { marketplaceVisibilityWhere } from "@/lib/api/plans/visibility";
import { getMinTrialPriceInPaise } from "@/lib/trials/pricing-config";

import { getSession } from "@/lib/auth-server";
import * as Sentry from "@sentry/nextjs";
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const consultantId = searchParams.get("consultantId");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
    const skip = (page - 1) * limit;

    // #726 — public marketplace must not surface ORG_ONLY plans.
    const where = {
      ...(consultantId ? { consultantProfileId: consultantId } : {}),
      ...marketplaceVisibilityWhere(),
    };

    const [subscriptionPlans, total] = await Promise.all([
      prisma.subscriptionPlan.findMany({
        where,
        include: {
          consultantProfile: true,
          topics: true,
          subscriptionContents: {
            orderBy: { order: "asc" },
          },
          // The offering editor hydrates from this list and PUTs the whole FAQ
          // array back, so a list that omits them saves an empty set over them.
          ...planContentInclude,
        },
        skip,
        take: limit,
      }),
      prisma.subscriptionPlan.count({ where }),
    ]);

    // Transform topics from objects to strings
    const transformedPlans = subscriptionPlans.map(transformTopicsToStrings);

    return NextResponse.json(
      {
        data: transformedPlans,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error fetching subscription plans:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    return NextResponse.json(
      { error: "An error occurred while fetching subscription plans" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    // Authentication check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const body = await request.json();
    const { consultantProfileId, ...planData } = body;

    if (!consultantProfileId) {
      return NextResponse.json(
        { error: "Consultant profile ID is required" },
        { status: 400 },
      );
    }

    // Verify ownership - user must own this consultant profile
    const consultantProfile = await prisma.consultantProfile.findFirst({
      where: {
        id: consultantProfileId,
        userId: session.user.id,
      },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        {
          error:
            "You do not have permission to create plans for this consultant profile",
        },
        { status: 403 },
      );
    }

    // Validate input with Zod schema
    const validationResult = SubscriptionPlanSchema.safeParse(planData);
    if (!validationResult.success) {
      return NextResponse.json(
        { error: "Validation failed", details: validationResult.error.issues },
        { status: 400 },
      );
    }

    const validatedData = validationResult.data;

    // Find or create topics by name
    const topicIds = await findOrCreateTopics(validatedData.topics ?? []);

    // Compute derived metrics
    const sessionDurationInHours = planData.sessionDurationInHours || 1.0;
    // Use accurate week counting instead of fixed * 4 approximation
    const metricStartDate = new Date();
    metricStartDate.setHours(0, 0, 0, 0);
    const metricEndDate = new Date(metricStartDate);
    metricEndDate.setMonth(
      metricEndDate.getMonth() + validatedData.durationInMonths,
    );
    const estimatedWeeks = SlotCalculationService.countWeeks(
      metricStartDate,
      metricEndDate,
    );
    const totalSessions = (validatedData.sessionsPerWeek || 1) * estimatedWeeks;
    const totalHours = totalSessions * sessionDurationInHours;

    // Trial fields — Zod-validated; free by default until paid-trial
    // checkout is wired (the wiring PR flips the default to ₹100).
    const trialEnabled = validatedData.trialEnabled ?? false;
    const trialDurationMinutes = validatedData.trialDurationMinutes ?? 30;
    const trialPriceInPaise = validatedData.trialPriceInPaise ?? 0;

    if (trialEnabled) {
      const floor = await getMinTrialPriceInPaise();
      if (trialPriceInPaise < floor) {
        return NextResponse.json(
          { error: `Trial price must be at least ₹${floor / 100}` },
          { status: 400 },
        );
      }
    }

    // Handle subscription contents (roadmap)
    const subscriptionContents = body.subscriptionContents as
      | Array<{
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

    const newSubscriptionPlan = await prisma.subscriptionPlan.create({
      data: {
        title: validatedData.title,
        description: validatedData.description,
        durationInMonths: validatedData.durationInMonths,
        price: Math.round(validatedData.price),
        priceCurrency: validatedData.priceCurrency,
        sessionsPerWeek: validatedData.sessionsPerWeek,
        sessionDurationInHours,
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
        faqs: faqCreateNested(validatedData.faqs),
        recordingEnabled: validatedData.recordingEnabled,
        recordingStoragePolicy: validatedData.recordingStoragePolicy,
        trialEnabled,
        trialDurationMinutes,
        trialPriceInPaise,
        consultantProfile: { connect: { id: consultantProfileId } },
        topics:
          topicIds.length > 0
            ? { connect: topicIds.map((id) => ({ id })) }
            : undefined,
        subscriptionContents:
          subscriptionContents && subscriptionContents.length > 0
            ? curriculumCreateNested(
                subscriptionContents.map((c) => ({
                  ...c,
                  hoursAllotted: c.hoursAllotted ?? 1.0,
                })),
              )
            : undefined,
      },
      include: {
        consultantProfile: true,
        topics: true,
        faqs: { orderBy: { order: "asc" } },
        subscriptionContents: {
          orderBy: { order: "asc" },
        },
      },
    });

    // Transform topics to strings in response
    return NextResponse.json(
      { data: transformTopicsToStrings(newSubscriptionPlan) },
      { status: 201 },
    );
  } catch (error) {
    console.error("Error creating subscription plan:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    return NextResponse.json(
      { error: "An error occurred while creating the subscription plan" },
      { status: 500 },
    );
  }
}
