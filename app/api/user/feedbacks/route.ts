import prisma from "lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { notifyFeedbackReceived } from "@/lib/novu";
import { CreateFeedbackSchema } from "@/schemas/feedbacks";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";

import { getSession } from "@/lib/auth-server";
import { assertBodySize } from "@/lib/validation/limits";
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be logged in to access your feedback" },
        { status: 401 },
      );
    }

    const feedbacks = await prisma.feedback.findMany({
      where: {
        userId: session.user.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json(feedbacks);
  } catch (error) {
    console.error("Error fetching feedbacks:", error);
    return NextResponse.json(
      {
        error: "An unexpected error occurred while fetching your feedback",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be logged in to submit feedback" },
        { status: 401 },
      );
    }

    // Rate limit: 5 feedbacks per hour per user
    const rl = await applyRateLimit(
      spamLimiter,
      `feedbacks:${session.user.id}`,
    );
    if (rl) return rl;

    // #831 — cap request body before parsing
    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const body = await req.json();
    const result = CreateFeedbackSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }
    const validatedData = result.data;

    const feedback = await prisma.feedback.create({
      data: {
        title: validatedData.title,
        description: validatedData.description,
        rating: validatedData.rating,
        category: validatedData.category,
        user: { connect: { id: session.user.id } },
      },
    });

    // Notify admin users about new feedback
    const adminUsers = await prisma.user.findMany({
      where: { role: { in: ["STAFF", "ADMIN"] } },
      select: { id: true },
    });
    void notifyFeedbackReceived(
      adminUsers.map((u) => u.id),
      {
        feedbackId: feedback.id,
        userName: session.user.name || "User",
        category: feedback.category || undefined,
        message: feedback.description || feedback.title || "New feedback",
        dashboardUrl: "/dashboard/admin/feedbacks",
      },
    );

    return NextResponse.json(feedback, { status: 201 });
  } catch (error) {
    console.error("Error creating feedback:", error);
    return NextResponse.json(
      {
        error: "An unexpected error occurred while submitting your feedback",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
