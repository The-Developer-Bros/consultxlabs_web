import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "lib/prisma";
import { FeedbackStatus } from "@prisma/client";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ feedbackId: string }> },
) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { feedbackId } = await params;

    const feedback = await prisma.feedback.findUnique({
      where: { id: feedbackId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            phone: true,
            createdAt: true,
          },
        },
      },
    });

    if (!feedback) {
      return NextResponse.json(
        { error: "Feedback not found" },
        { status: 404 },
      );
    }

    return NextResponse.json(feedback);
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "staff" } });
    console.error("Error fetching feedback:", error);
    return NextResponse.json(
      { error: "Failed to fetch feedback" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ feedbackId: string }> },
) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { feedbackId } = await params;
    const body = await req.json();

    // Validate status if provided
    if (body.status && !Object.values(FeedbackStatus).includes(body.status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }

    const feedback = await prisma.feedback.update({
      where: { id: feedbackId },
      data: {
        ...(body.status && { status: body.status }),
      },
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
    });

    return NextResponse.json(feedback);
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "staff" } });
    console.error("Error updating feedback:", error);
    return NextResponse.json(
      { error: "Failed to update feedback" },
      { status: 500 },
    );
  }
}
