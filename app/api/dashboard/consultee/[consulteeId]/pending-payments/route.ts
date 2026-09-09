import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { scopeToWhereOrgId } from "@/lib/api/scope/parse";
import { AppointmentStatus, TrialSessionStatus } from "@prisma/client";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

/**
 * GET /api/dashboard/consultee/[consulteeId]/pending-payments
 * Fetch pending payments for this consultee from two sources:
 * 1. Consultations/subscriptions with APPROVED_PENDING_PAYMENT status (awaiting checkout)
 * 2. Payment records with paymentStatus PENDING (checkout initiated, awaiting gateway confirmation)
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ consulteeId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { consulteeId } = await params;

    if (
      !isPrivileged(session.user.role) &&
      session.user.consulteeProfileId !== consulteeId
    ) {
      return forbiddenResponse("You can only access your own pending payments");
    }

    // Fetch consultee profile to get their userId
    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { id: consulteeId },
      select: { id: true, userId: true },
    });

    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    // #1182 — what an unpaid item QUOTES is the amount frozen onto its
    // Payment row when the pay-link was minted, never the plan's live price
    // (a consultant repricing after acceptance must not move the number the
    // gateway will charge). Newest live payment per appointment — a re-mint
    // (expired/failed order replaced, #1181 reuse semantics) freezes the
    // CURRENT quote onto a newer row, so the newest is the operative charge.
    // Falls back to the plan only before any payment exists, where the plan
    // price genuinely is the quote.
    const frozenPaymentSelect = {
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" as const },
      take: 1,
      select: { amount: true, currency: true },
    } as const;

    const planInclude = {
      select: {
        title: true,
        consultantProfile: {
          select: {
            user: { select: { name: true } },
          },
        },
      },
    } as const;

    // Fetch all four data sources in parallel
    //
    // #1166 ORG-4 — personal surface: sources 1-3 pin the personal scope
    // (ADR 19; same personal filter as the payments route). Org-funded
    // checkouts settle on the org side and never owe the learner a payment.
    // Trials (source 4) stay unpinned: org tags on trials are attribution
    // only, and a paid trial always charges the consultee.
    //
    // #674 defect 13 — the pin is projected from the shared Scope vocabulary
    // rather than written out four times as a literal.
    const personalOrgPin = scopeToWhereOrgId({ kind: "personal" });
    const [
      pendingConsultations,
      pendingSubscriptions,
      pendingGatewayPayments,
      pendingTrials,
    ] = await Promise.all([
      // Source 1: Consultations with APPROVED_PENDING_PAYMENT status
      prisma.consultation.findMany({
        where: {
          requestedById: consulteeId,
          status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
          appointment: { is: personalOrgPin },
        },
        include: {
          consultationPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: { select: { name: true } },
                },
              },
            },
          },
          // Cancel affordance keys on the Appointment record id
          // (POST /api/appointments/[appointmentId]/cancel); the frozen
          // charge rides the same appointment (#1182).
          appointment: { select: { id: true, payment: frozenPaymentSelect } },
        },
        orderBy: { updatedAt: "desc" },
      }),

      // Source 2: Subscriptions with APPROVED_PENDING_PAYMENT status
      prisma.subscription.findMany({
        where: {
          requestedById: consulteeId,
          status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
          appointments: { some: personalOrgPin },
        },
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: { select: { name: true } },
                },
              },
            },
          },
          // Any one appointment id suffices — the cancel route resolves
          // the parent subscription from it and transitions the whole row.
          // Ordered like the mint's pick (#1181) so take: 1 lands on the
          // appointment the pay-link anchored to, which carries the frozen
          // charge (#1182). Pinned to PERSONAL appointments (matching this
          // surface's organizationId: null filter): a mixed subscription
          // with an earlier org-funded appointment must not leak its frozen
          // amount onto the personal dashboard.
          appointments: {
            where: personalOrgPin,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true, payment: frozenPaymentSelect },
            take: 1,
          },
        },
        orderBy: { updatedAt: "desc" },
      }),

      // Source 3: Payment records with PENDING gateway status (non-expired only)
      prisma.payment.findMany({
        where: {
          userId: consulteeProfile.userId,
          paymentStatus: "PENDING",
          ...personalOrgPin,
          OR: [
            // Has explicit expiresAt that's still in the future
            { expiresAt: { gt: new Date() } },
            // No expiresAt but created within last 30 min (default checkout window)
            {
              expiresAt: null,
              createdAt: { gt: new Date(Date.now() - 30 * 60 * 1000) },
            },
          ],
        },
        include: {
          appointment: {
            select: {
              appointmentType: true,
              consultation: {
                select: { consultationPlan: planInclude },
              },
              subscription: {
                select: { subscriptionPlan: planInclude },
              },
              webinar: {
                select: { webinarPlan: planInclude },
              },
              class: {
                select: { classPlan: planInclude },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),

      // Source 4: Paid trials the consultant accepted but the learner hasn't
      // paid for yet. Unlike the sources above these carry a real deadline
      // (paymentDueAt) rather than an assumed 48h window.
      prisma.trialSession.findMany({
        where: {
          consulteeProfileId: consulteeId,
          status: TrialSessionStatus.AWAITING_PAYMENT,
        },
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { name: true } } },
              },
            },
          },
          appointment: { select: { id: true } },
          // A paid trial owns its Payment directly (TrialSession.paymentId);
          // it holds the frozen charge the same way (#1182). Free trials
          // have none and keep quoting the plan's trial price.
          payment: { select: { amount: true, currency: true } },
        },
        orderBy: { updatedAt: "desc" },
      }),
    ]);

    // Transform approval-pending consultations
    const approvalPendingItems = [
      ...pendingConsultations.map((consultation) => {
        const expiresAt = new Date(
          consultation.updatedAt.getTime() + 48 * 60 * 60 * 1000,
        ); // 48 hours from approval
        const isExpiringSoon =
          expiresAt.getTime() - Date.now() < 24 * 60 * 60 * 1000;
        // #1182 — frozen charge first; the plan is only the pre-mint quote.
        const frozen = consultation.appointment?.payment[0];

        return {
          id: consultation.id,
          appointmentId: consultation.appointment?.id ?? null,
          type: "consultation" as const,
          title: consultation.consultationPlan?.title || "Consultation",
          consultantName:
            consultation.consultationPlan?.consultantProfile?.user?.name ||
            "Consultant",
          amount: frozen?.amount ?? (consultation.consultationPlan?.price || 0),
          currency:
            (frozen?.currency ??
              consultation.consultationPlan?.priceCurrency) ||
            "INR",
          paymentUrl: consultation.pendingPaymentUrl || "",
          approvedAt: consultation.updatedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          isExpiringSoon,
          source: "approval_pending" as const,
        };
      }),
      ...pendingSubscriptions.map((subscription) => {
        const expiresAt = new Date(
          subscription.updatedAt.getTime() + 48 * 60 * 60 * 1000,
        );
        const isExpiringSoon =
          expiresAt.getTime() - Date.now() < 24 * 60 * 60 * 1000;
        // #1182 — frozen charge first; the plan is only the pre-mint quote.
        const frozen = subscription.appointments[0]?.payment[0];

        return {
          id: subscription.id,
          appointmentId: subscription.appointments[0]?.id ?? null,
          type: "subscription" as const,
          title: subscription.subscriptionPlan?.title || "Subscription",
          consultantName:
            subscription.subscriptionPlan?.consultantProfile?.user?.name ||
            "Consultant",
          amount: frozen?.amount ?? (subscription.subscriptionPlan?.price || 0),
          currency:
            (frozen?.currency ??
              subscription.subscriptionPlan?.priceCurrency) ||
            "INR",
          paymentUrl: subscription.pendingPaymentUrl || "",
          approvedAt: subscription.updatedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          isExpiringSoon,
          source: "approval_pending" as const,
        };
      }),
      ...pendingTrials.map((trial) => {
        // Real deadline, not the 48h assumption used above — a trial's slot may
        // be sooner than that, in which case paymentDueAt is clamped to it.
        const expiresAt = trial.paymentDueAt ?? trial.updatedAt;
        const isExpiringSoon =
          expiresAt.getTime() - Date.now() < 24 * 60 * 60 * 1000;
        // #1182 — frozen charge first; the plan's trial price is only the
        // pre-mint quote (and the whole quote for free trials, which never
        // mint one).
        const frozen = trial.payment;

        return {
          id: trial.id,
          appointmentId: trial.appointment?.id ?? null,
          type: "trial" as const,
          title: `${trial.subscriptionPlan?.title ?? "Trial"} — trial`,
          consultantName:
            trial.subscriptionPlan?.consultantProfile?.user?.name ||
            "Consultant",
          amount:
            frozen?.amount ??
            Number(trial.subscriptionPlan?.trialPriceInPaise ?? 0),
          currency:
            (frozen?.currency ?? trial.subscriptionPlan?.priceCurrency) ||
            "INR",
          paymentUrl: trial.pendingPaymentUrl || "",
          approvedAt: trial.updatedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          isExpiringSoon,
          source: "approval_pending" as const,
        };
      }),
    ];

    // Transform gateway-pending payments
    const gatewayPendingItems = pendingGatewayPayments.map((payment) => {
      const apt = payment.appointment;
      const planTitle =
        apt?.consultation?.consultationPlan?.title ??
        apt?.subscription?.subscriptionPlan?.title ??
        apt?.webinar?.webinarPlan?.title ??
        apt?.class?.classPlan?.title ??
        "Payment";
      const consultantName =
        apt?.consultation?.consultationPlan?.consultantProfile?.user?.name ??
        apt?.subscription?.subscriptionPlan?.consultantProfile?.user?.name ??
        apt?.webinar?.webinarPlan?.consultantProfile?.user?.name ??
        apt?.class?.classPlan?.consultantProfile?.user?.name ??
        "Consultant";
      const type =
        (apt?.appointmentType?.toLowerCase() as
          | "consultation"
          | "subscription"
          | "webinar"
          | "class") || "consultation";

      // Gateway-pending payments expire based on expiresAt or default to 30 min from creation
      const expiresAt =
        payment.expiresAt ||
        new Date(payment.createdAt.getTime() + 30 * 60 * 1000);
      const isExpiringSoon = expiresAt.getTime() - Date.now() < 10 * 60 * 1000; // < 10 min

      return {
        id: payment.id,
        type,
        title: planTitle,
        consultantName,
        amount: payment.amount,
        currency: payment.currency,
        paymentUrl: "",
        approvedAt: payment.createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        isExpiringSoon,
        source: "gateway_pending" as const,
      };
    });

    // Merge and sort: expiring soon first, then by date (newest first)
    const pendingPayments = [
      ...approvalPendingItems,
      ...gatewayPendingItems,
    ].sort((a, b) => {
      if (a.isExpiringSoon && !b.isExpiringSoon) return -1;
      if (!a.isExpiringSoon && b.isExpiringSoon) return 1;
      return (
        new Date(b.approvedAt).getTime() - new Date(a.approvedAt).getTime()
      );
    });

    return NextResponse.json({
      pendingPayments,
      count: pendingPayments.length,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "dashboard" } },
    );
    console.error("Error fetching pending payments:", error);
    return NextResponse.json(
      {
        error: "An error occurred while fetching pending payments",
        pendingPayments: [],
        count: 0,
      },
      { status: 500 },
    );
  }
}
