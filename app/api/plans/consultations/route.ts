import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { ConsultationPlanSchema } from "@/schemas/plans";
import { findOrCreateTopics, transformTopicsToStrings } from "@/lib/topics";
import { marketplaceVisibilityWhere } from "@/lib/api/plans/visibility";
import { faqCreateNested, planContentInclude } from "@/lib/api/plans/content";
import * as Sentry from "@sentry/nextjs";
import { getSession } from "@/lib/auth-server";
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

    const [consultationPlans, total] = await Promise.all([
      prisma.consultationPlan.findMany({
        where,
        include: {
          consultantProfile: true,
          topics: true,
          // The offering editor hydrates from this list and PUTs the whole FAQ
          // array back, so a list that omits them saves an empty set over them.
          ...planContentInclude,
        },
        skip,
        take: limit,
      }),
      prisma.consultationPlan.count({ where }),
    ]);

    // Transform topics from objects to strings
    const transformedPlans = consultationPlans.map(transformTopicsToStrings);

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
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    console.error("Error fetching consultation plans:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching consultation plans" },
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
    const validationResult = ConsultationPlanSchema.safeParse(planData);
    if (!validationResult.success) {
      return NextResponse.json(
        { error: "Validation failed", details: validationResult.error.issues },
        { status: 400 },
      );
    }

    const validatedData = validationResult.data;

    // Find or create topics by name
    const topicIds = await findOrCreateTopics(validatedData.topics ?? []);

    const newConsultationPlan = await prisma.consultationPlan.create({
      data: {
        title: validatedData.title,
        description: validatedData.description,
        durationInHours: validatedData.durationInHours,
        price: Math.round(validatedData.price),
        priceCurrency: validatedData.priceCurrency,
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
        consultantProfile: { connect: { id: consultantProfileId } },
        topics:
          topicIds.length > 0
            ? { connect: topicIds.map((id) => ({ id })) }
            : undefined,
      },
      include: {
        consultantProfile: true,
        topics: true,
        faqs: { orderBy: { order: "asc" } },
      },
    });

    // Transform topics to strings in response
    return NextResponse.json(
      { data: transformTopicsToStrings(newConsultationPlan) },
      { status: 201 },
    );
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    console.error("Error creating consultation plan:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the consultation plan" },
      { status: 500 },
    );
  }
}
