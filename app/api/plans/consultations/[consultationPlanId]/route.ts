import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { ConsultationPlanSchema } from "@/schemas/plans";
import { faqReplaceNested } from "@/lib/api/plans/content";
import { findOrCreateTopics, transformTopicsToStrings } from "@/lib/topics";
import {
  archivedAtForArchive,
  parsePlanArchiveBody,
  PLAN_ORG_GOVERNED_RESPONSE,
  PLAN_ARCHIVE_RESPONSE_NOTE,
} from "@/lib/api/plans/archive";

import { getSession } from "@/lib/auth-server";
import * as Sentry from "@sentry/nextjs";
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ consultationPlanId: string }> },
) {
  try {
    const { consultationPlanId } = await params;
    const consultationPlan = await prisma.consultationPlan.findUniqueOrThrow({
      where: { id: consultationPlanId },
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
            domain: true,
            subDomains: true,
            tags: true,
          },
        },
        consultations: true,
        topics: true,
        faqs: { orderBy: { order: "asc" } },
      },
    });

    return NextResponse.json(
      { data: transformTopicsToStrings(consultationPlan) },
      { status: 200 },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Consultation plan not found" },
        { status: 404 },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    console.error("Error fetching consultation plan:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the consultation plan" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ consultationPlanId: string }> },
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

    const { consultationPlanId } = await params;

    // Verify ownership - user must own this consultation plan
    const existingPlan = await prisma.consultationPlan.findUnique({
      where: { id: consultationPlanId },
      include: { consultantProfile: true },
    });

    if (!existingPlan) {
      return NextResponse.json(
        { error: "Consultation plan not found" },
        { status: 404 },
      );
    }

    if (existingPlan.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        {
          error: "You do not have permission to update this consultation plan",
        },
        { status: 403 },
      );
    }

    const body = await request.json();

    // Validate input with Zod schema (partial for updates)
    const validationResult = ConsultationPlanSchema.partial().safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        { error: "Validation failed", details: validationResult.error.issues },
        { status: 400 },
      );
    }

    const validatedData = validationResult.data;

    // Handle topics if provided
    let topicsUpdate = {};
    if (validatedData.topics !== undefined) {
      const topicIds = await findOrCreateTopics(validatedData.topics);
      topicsUpdate = {
        topics: { set: topicIds.map((id) => ({ id })) },
      };
    }

    const consultationPlan = await prisma.consultationPlan.update({
      where: { id: consultationPlanId },
      data: {
        title: validatedData.title,
        description: validatedData.description,
        durationInHours: validatedData.durationInHours,
        price:
          validatedData.price !== undefined
            ? Math.round(validatedData.price)
            : undefined,
        priceCurrency: validatedData.priceCurrency,
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
        ...topicsUpdate,
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
            domain: true,
            subDomains: true,
            tags: true,
          },
        },
        consultations: true,
        topics: true,
        faqs: { orderBy: { order: "asc" } },
      },
    });

    return NextResponse.json(
      { data: transformTopicsToStrings(consultationPlan) },
      { status: 200 },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Consultation plan not found" },
        { status: 404 },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    console.error("Error updating consultation plan:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the consultation plan" },
      { status: 500 },
    );
  }
}

/**
 * Sole-owner archive/restore (#1494) — a consultant stops selling a 1:1
 * offering without the org-catalog bulk-archive path and without the
 * DELETE this plan family refuses once it has associated consultations.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ consultationPlanId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const { consultationPlanId } = await params;

    const parsedBody = await parsePlanArchiveBody(request);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.error, details: parsedBody.details },
        { status: 400 },
      );
    }
    const { archived } = parsedBody;

    const existingPlan = await prisma.consultationPlan.findUnique({
      where: { id: consultationPlanId },
      include: { consultantProfile: true },
    });

    if (!existingPlan) {
      return NextResponse.json(
        { error: "Consultation plan not found" },
        { status: 404 },
      );
    }

    if (existingPlan.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        {
          error: "You do not have permission to update this consultation plan",
        },
        { status: 403 },
      );
    }

    if (existingPlan.organizationId) {
      return NextResponse.json(PLAN_ORG_GOVERNED_RESPONSE, { status: 403 });
    }

    const consultationPlan = await prisma.consultationPlan.update({
      where: { id: consultationPlanId },
      data: {
        archivedAt: archived
          ? archivedAtForArchive(existingPlan.archivedAt)
          : null,
      },
    });

    return NextResponse.json(
      {
        data: { id: consultationPlan.id, archivedAt: consultationPlan.archivedAt },
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
        { error: "Consultation plan not found" },
        { status: 404 },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    console.error("Error archiving consultation plan:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the consultation plan" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ consultationPlanId: string }> },
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

    const { consultationPlanId } = await params;

    // Verify ownership - user must own this consultation plan
    const existingPlan = await prisma.consultationPlan.findUnique({
      where: { id: consultationPlanId },
      include: { consultantProfile: true },
    });

    if (!existingPlan) {
      return NextResponse.json(
        { error: "Consultation plan not found" },
        { status: 404 },
      );
    }

    if (existingPlan.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        {
          error: "You do not have permission to delete this consultation plan",
        },
        { status: 403 },
      );
    }

    // Check if there are any associated consultations
    const associatedConsultations = await prisma.consultation.findMany({
      where: { consultationPlanId },
    });

    if (associatedConsultations.length > 0) {
      return NextResponse.json(
        {
          error:
            "Cannot delete consultation plan with associated consultations",
        },
        { status: 400 },
      );
    }

    const consultationPlan = await prisma.consultationPlan.delete({
      where: { id: consultationPlanId },
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
            domain: true,
            subDomains: true,
            tags: true,
          },
        },
        topics: true,
      },
    });

    return NextResponse.json(
      { data: transformTopicsToStrings(consultationPlan) },
      { status: 200 },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Consultation plan not found" },
        { status: 404 },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    console.error("Error deleting consultation plan:", error);
    return NextResponse.json(
      { error: "An error occurred while deleting the consultation plan" },
      { status: 500 },
    );
  }
}
