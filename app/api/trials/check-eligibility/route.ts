import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { blocksNewTrialRequest } from "@/lib/trials/eligibility";
import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth, isPrivileged } from "@/lib/auth-helpers";

/**
 * GET /api/trials/check-eligibility
 * Check if a consultee is eligible to request a trial for a specific consultant
 *
 * Query params:
 * - consulteeProfileId: The consultee's profile ID
 * - consultantProfileId: The consultant's profile ID
 * - subscriptionPlanId: Optional - check if specific plan has trial enabled
 */
export async function GET(request: NextRequest) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const { searchParams } = new URL(request.url);
  const consulteeProfileId = searchParams.get("consulteeProfileId");
  const consultantProfileId = searchParams.get("consultantProfileId");
  const subscriptionPlanId = searchParams.get("subscriptionPlanId");

  if (!consulteeProfileId || !consultantProfileId) {
    return NextResponse.json(
      { error: "consulteeProfileId and consultantProfileId are required" },
      { status: 400 },
    );
  }

  // IDOR protection: non-privileged users can only check their own eligibility
  if (!isPrivileged(session.user.role)) {
    if (
      consulteeProfileId !== session.user.consulteeProfileId &&
      consultantProfileId !== session.user.consultantProfileId
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  try {
    // Check if a trial already exists for this consultee-consultant pair
    const existingTrial = await prisma.trialSession.findUnique({
      where: {
        consulteeProfileId_consultantProfileId: {
          consulteeProfileId,
          consultantProfileId,
        },
      },
      select: {
        id: true,
        status: true,
        subscriptionPlanId: true,
        requestedAt: true,
      },
    });

    // If specific plan is requested, check if it has trial enabled
    let planTrialEnabled = true;
    let planTrialDuration = 30;
    let planTrialPriceInPaise = 0;

    if (subscriptionPlanId) {
      const plan = await prisma.subscriptionPlan.findUnique({
        where: { id: subscriptionPlanId },
        select: {
          trialEnabled: true,
          trialDurationMinutes: true,
          trialPriceInPaise: true,
          title: true,
        },
      });

      if (!plan) {
        return NextResponse.json(
          { error: "Subscription plan not found" },
          { status: 404 },
        );
      }

      planTrialEnabled = plan.trialEnabled;
      planTrialDuration = plan.trialDurationMinutes;
      planTrialPriceInPaise = plan.trialPriceInPaise;
    }

    // Get all plans with trial enabled for this consultant
    const plansWithTrialEnabled = await prisma.subscriptionPlan.findMany({
      where: {
        consultantProfileId,
        trialEnabled: true,
      },
      select: {
        id: true,
        title: true,
        trialDurationMinutes: true,
        trialPriceInPaise: true,
      },
    });

    // A prior trial only blocks if it's live or was actually delivered — a
    // declined, withdrawn or lapsed-unpaid trial frees the pair. See
    // lib/trials/eligibility.ts for the abuse trade-off this represents.
    const blockingTrial =
      existingTrial && blocksNewTrialRequest(existingTrial.status)
        ? existingTrial
        : null;
    const isEligible = !blockingTrial && planTrialEnabled;

    return NextResponse.json({
      data: {
        isEligible,
        hasExistingTrial: !!blockingTrial,
        existingTrial: blockingTrial
          ? {
              id: blockingTrial.id,
              status: blockingTrial.status,
              subscriptionPlanId: blockingTrial.subscriptionPlanId,
              requestedAt: blockingTrial.requestedAt,
            }
          : null,
        planTrialEnabled,
        planTrialDuration,
        planTrialPriceInPaise,
        plansWithTrialEnabled,
        reason: !isEligible
          ? blockingTrial
            ? "You have already requested or completed a trial with this consultant"
            : "This plan does not offer trials"
          : null,
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "trials" } });
    console.error("Error checking trial eligibility:", error);
    return NextResponse.json(
      { error: "An error occurred while checking trial eligibility" },
      { status: 500 },
    );
  }
}
