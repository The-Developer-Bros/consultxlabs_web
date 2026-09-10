import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { AppointmentStatus, TrialSessionStatus } from "@prisma/client";
import { getSession } from "@/lib/auth-server";

/**
 * GET /api/dashboard/admin/approval-payments
 * Fetch all consultations and subscriptions that are in APPROVED_PENDING_PAYMENT status
 * This endpoint is used by admins to monitor approval payments and identify expired payment links
 */
export async function GET() {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Three fully independent reads — run concurrently instead of paying the
    // sum of three round trips serially.
    //
    // take: 200 (newest first) caps these admin-wide scans: this endpoint is a
    // live monitoring table, not an audit export, and APPROVED_PENDING_PAYMENT
    // rows are transient (48h expiry + sweeper). Without a bound the query
    // cost grows unboundedly with platform history.
    const TAKE_LIMIT = 200;

    const [pendingConsultations, pendingSubscriptions, pendingTrials] =
      await Promise.all([
        // Consultations with APPROVED_PENDING_PAYMENT status
        prisma.consultation.findMany({
          where: {
            status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
          },
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        name: true,
                        email: true,
                      },
                    },
                  },
                },
              },
            },
            requestedBy: {
              include: {
                user: {
                  select: {
                    name: true,
                    email: true,
                  },
                },
              },
            },
            appointment: {
              include: {
                payment: {
                  where: {
                    paymentStatus: {
                      in: ["PENDING"],
                    },
                  },
                  orderBy: {
                    createdAt: "desc",
                  },
                  take: 1,
                },
              },
            },
          },
          orderBy: {
            updatedAt: "desc",
          },
          take: TAKE_LIMIT,
        }),

        // Subscriptions with APPROVED_PENDING_PAYMENT status
        prisma.subscription.findMany({
          where: {
            status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
          },
          include: {
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        name: true,
                        email: true,
                      },
                    },
                  },
                },
              },
            },
            requestedBy: {
              include: {
                user: {
                  select: {
                    name: true,
                    email: true,
                  },
                },
              },
            },
            appointments: {
              include: {
                payment: {
                  where: {
                    paymentStatus: {
                      in: ["PENDING"],
                    },
                  },
                  orderBy: {
                    createdAt: "desc",
                  },
                  take: 1,
                },
              },
              take: 1,
            },
          },
          orderBy: {
            updatedAt: "desc",
          },
          take: TAKE_LIMIT,
        }),

        // Paid trials the consultant accepted but the learner hasn't paid for.
        // Support needs these alongside consultations/subscriptions — the failure
        // mode is identical (accepted, slot held, money not collected).
        prisma.trialSession.findMany({
          where: { status: TrialSessionStatus.AWAITING_PAYMENT },
          include: {
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: { user: { select: { name: true, email: true } } },
                },
              },
            },
            consulteeProfile: {
              include: { user: { select: { name: true, email: true } } },
            },
          },
          orderBy: { updatedAt: "desc" },
          take: TAKE_LIMIT,
        }),
      ]);

    // Transform data into a consistent format
    const approvalPayments = [
      ...pendingConsultations.map((consultation) => {
        const expiresAt = new Date(
          consultation.updatedAt.getTime() + 48 * 60 * 60 * 1000,
        ); // 48 hours from approval
        const now = Date.now();
        const timeUntilExpiry = expiresAt.getTime() - now;
        const isExpired = timeUntilExpiry < 0;
        const isExpiringSoon =
          !isExpired && timeUntilExpiry < 24 * 60 * 60 * 1000; // < 24 hours

        return {
          id: consultation.id,
          type: "consultation" as const,
          title: consultation.consultationPlan?.title || "Consultation",
          consultantName:
            consultation.consultationPlan?.consultantProfile?.user?.name ||
            "Unknown Consultant",
          consultantEmail:
            consultation.consultationPlan?.consultantProfile?.user?.email || "",
          consulteeName:
            consultation.requestedBy?.user?.name || "Unknown Consultee",
          consulteeEmail: consultation.requestedBy?.user?.email || "",
          amount: consultation.consultationPlan?.price || 0,
          currency: consultation.consultationPlan?.priceCurrency || "INR",
          paymentUrl: consultation.pendingPaymentUrl || "",
          approvedAt: consultation.updatedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          isExpired,
          isExpiringSoon,
          status: consultation.status,
        };
      }),
      ...pendingSubscriptions.map((subscription) => {
        const expiresAt = new Date(
          subscription.updatedAt.getTime() + 48 * 60 * 60 * 1000,
        ); // 48 hours from approval
        const now = Date.now();
        const timeUntilExpiry = expiresAt.getTime() - now;
        const isExpired = timeUntilExpiry < 0;
        const isExpiringSoon =
          !isExpired && timeUntilExpiry < 24 * 60 * 60 * 1000; // < 24 hours

        return {
          id: subscription.id,
          type: "subscription" as const,
          title: subscription.subscriptionPlan?.title || "Subscription",
          consultantName:
            subscription.subscriptionPlan?.consultantProfile?.user?.name ||
            "Unknown Consultant",
          consultantEmail:
            subscription.subscriptionPlan?.consultantProfile?.user?.email || "",
          consulteeName:
            subscription.requestedBy?.user?.name || "Unknown Consultee",
          consulteeEmail: subscription.requestedBy?.user?.email || "",
          amount: subscription.subscriptionPlan?.price || 0,
          currency: subscription.subscriptionPlan?.priceCurrency || "INR",
          paymentUrl: subscription.pendingPaymentUrl || "",
          approvedAt: subscription.updatedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          isExpired,
          isExpiringSoon,
          status: subscription.status,
        };
      }),
      ...pendingTrials.map((trial) => {
        // Trials carry a real deadline instead of the 48h assumption above.
        const expiresAt = trial.paymentDueAt ?? trial.updatedAt;
        const timeUntilExpiry = expiresAt.getTime() - Date.now();
        const isExpired = timeUntilExpiry < 0;
        const isExpiringSoon =
          !isExpired && timeUntilExpiry < 24 * 60 * 60 * 1000;

        return {
          id: trial.id,
          type: "trial" as const,
          title: `${trial.subscriptionPlan?.title ?? "Trial"} — trial`,
          consultantName:
            trial.subscriptionPlan?.consultantProfile?.user?.name ||
            "Unknown Consultant",
          consultantEmail:
            trial.subscriptionPlan?.consultantProfile?.user?.email || "",
          consulteeName:
            trial.consulteeProfile?.user?.name || "Unknown Consultee",
          consulteeEmail: trial.consulteeProfile?.user?.email || "",
          amount: Number(trial.subscriptionPlan?.trialPriceInPaise ?? 0),
          currency: trial.subscriptionPlan?.priceCurrency || "INR",
          paymentUrl: trial.pendingPaymentUrl || "",
          approvedAt: trial.updatedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          isExpired,
          isExpiringSoon,
          status: trial.status,
        };
      }),
    ].sort((a, b) => {
      // Sort by: expired first, then expiring soon, then by approval date (newest first)
      if (a.isExpired && !b.isExpired) return -1;
      if (!a.isExpired && b.isExpired) return 1;
      if (a.isExpiringSoon && !b.isExpiringSoon && !a.isExpired && !b.isExpired)
        return -1;
      if (!a.isExpiringSoon && b.isExpiringSoon && !a.isExpired && !b.isExpired)
        return 1;
      return (
        new Date(b.approvedAt).getTime() - new Date(a.approvedAt).getTime()
      );
    });

    return NextResponse.json({
      approvalPayments,
      count: approvalPayments.length,
      expiredCount: approvalPayments.filter((p) => p.isExpired).length,
      expiringSoonCount: approvalPayments.filter(
        (p) => p.isExpiringSoon && !p.isExpired,
      ).length,
      activeCount: approvalPayments.filter(
        (p) => !p.isExpired && !p.isExpiringSoon,
      ).length,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "dashboard" } },
    );
    console.error("Error fetching approval payments:", error);
    return NextResponse.json(
      {
        error: "An error occurred while fetching approval payments",
        approvalPayments: [],
        count: 0,
      },
      { status: 500 },
    );
  }
}
