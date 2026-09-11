import * as Sentry from "@sentry/nextjs";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import prisma, { type Tx } from "@/lib/prisma";
import {
  PaymentGateway,
  PaymentStatus,
  Prisma,
  AppointmentStatus,
} from "@prisma/client";
import { addMonths } from "date-fns";
import { NextRequest, NextResponse } from "next/server";
import {
  ApprovalWindowLapsedError,
  createApprovalPaymentIntent,
} from "@/lib/payments/operations/approval-payment";
import { APPROVAL_PAYMENT_EXPIRATION_MS } from "@/lib/payments/constants";
import {
  APPROVAL_LOCK_TTL_MS,
  ApprovalLockLostError,
  type ApprovalLock,
  lockSubscriptionApproval,
  renewApprovalLock,
  unlockApproval,
} from "@/utils/appointmentlock";
import { transitionSubscriptionRequest } from "@/lib/booking/transitions";
import { refundRejectedRequest } from "@/lib/booking/rejection-refund";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { sendPaymentLinkEmail } from "@/lib/email";
import {
  notifySubscriptionStarted,
  notifySubscriptionCancelled,
} from "@/lib/novu";
import { logSubscriptionCancelled } from "@/lib/activity/log-activity";
import {
  UpdateSubscriptionSchema,
  PatchSubscriptionStatusSchema,
} from "@/schemas/subscriptions";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { createDirectMessageChannel } from "@/actions/stream/chat/channel.action";
import { streamLogger } from "@/lib/stream-logger";
import { bookingOrgId } from "@/lib/stream-utils";

/**
 * Type for subscription with all related details needed for payment processing.
 * Derived via the extended client — raw GetPayload would re-introduce bigint
 * money fields (#780).
 */
type SubscriptionWithDetails = Prisma.Result<
  typeof prisma.subscription,
  {
    include: {
      subscriptionPlan: {
        include: {
          consultantProfile: {
            include: {
              user: true;
            };
          };
        };
      };
      requestedBy: {
        include: {
          user: true;
        };
      };
      appointments: {
        include: {
          slotsOfAppointment: {
            include: {
              user: true;
            };
          };
        };
      };
    };
  },
  "findFirstOrThrow"
>;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  // Require authentication
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { subscriptionId } = await params;
    const subscriptionData = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
      include: {
        subscriptionPlan: {
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
          },
        },
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
        appointments: {
          include: {
            slotsOfAppointment: {
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
      },
    });

    // Check authorization: must be a participant or privileged
    const isConsultant =
      !!subscriptionData.subscriptionPlan?.consultantProfile?.id &&
      subscriptionData.subscriptionPlan.consultantProfile.id ===
        session.user.consultantProfileId;
    const isConsultee =
      !!subscriptionData.requestedById &&
      subscriptionData.requestedById === session.user.consulteeProfileId;
    if (!isPrivileged(session.user.role) && !isConsultant && !isConsultee) {
      return forbiddenResponse(
        "You can only view subscriptions you are a participant in",
      );
    }

    return NextResponse.json({ data: subscriptionData }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Subscription not found" },
        { status: 404 },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("Error fetching subscription:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the subscription" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  // Require authentication
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { subscriptionId } = await params;
    const body = await request.json();
    const result = UpdateSubscriptionSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }
    const validatedData = result.data;

    // Verify ownership before allowing update
    const existingSubscription = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        subscriptionPlan: {
          include: {
            consultantProfile: true,
          },
        },
      },
    });

    if (!existingSubscription) {
      return NextResponse.json(
        { error: "Subscription not found" },
        { status: 404 },
      );
    }

    // Check authorization: must be a participant or privileged
    const isConsultant =
      !!existingSubscription.subscriptionPlan?.consultantProfile?.id &&
      existingSubscription.subscriptionPlan.consultantProfile.id ===
        session.user.consultantProfileId;
    const isConsultee =
      !!existingSubscription.requestedById &&
      existingSubscription.requestedById === session.user.consulteeProfileId;
    if (!isPrivileged(session.user.role) && !isConsultant && !isConsultee) {
      return forbiddenResponse(
        "You can only modify subscriptions you are a participant in",
      );
    }

    const subscriptionData = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        schedulingPeriodStartsAt: validatedData.schedulingPeriodStartsAt,
        schedulingPeriodEndsAt: validatedData.schedulingPeriodEndsAt,
        requestNotes: validatedData.requestNotes,
        feedbackFromConsultee: validatedData.feedbackFromConsultee,
        feedbackFromConsultant: validatedData.feedbackFromConsultant,
        rating: validatedData.rating,
        subscriptionPlan: validatedData.planId
          ? {
              connect: { id: validatedData.planId },
            }
          : undefined,
      },
      include: {
        subscriptionPlan: {
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
          },
        },
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
        appointments: {
          include: {
            slotsOfAppointment: {
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
      },
    });

    return NextResponse.json({ data: subscriptionData }, { status: 200 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("Error updating subscription:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the subscription" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  // Require authentication
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;

  // Doctrine rule 2 — nothing is deleted. This ADMIN-only route used to run a
  // raw `prisma.subscription.delete`, whose cascades reach every Appointment
  // of the plan and from there the Payments pointing at those appointments
  // (Payment.appointment onDelete: Cascade) — or FK-fail on
  // Refund.payment onDelete: Restrict, surfacing as a 500. Bookings are
  // soft-cancelled through the cancel API, which routes refunds through the
  // booking front door.
  void params;
  return NextResponse.json(
    {
      error:
        "Deleting bookings is not supported. Cancel via " +
        "POST /api/appointments/{appointmentId}/cancel, which soft-cancels " +
        "and refunds through the booking front door.",
      code: "DELETE_NOT_SUPPORTED",
    },
    { status: 405 },
  );
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  // Require authentication
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const body = await request.json();
    const patchResult = PatchSubscriptionStatusSchema.safeParse(body);
    if (!patchResult.success) {
      return NextResponse.json(
        { error: "Validation failed", details: patchResult.error.issues },
        { status: 400 },
      );
    }
    const { status } = patchResult.data;
    const { subscriptionId } = await params;

    // First fetch the subscription to validate it exists and get all necessary data
    const existingSubscription = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        subscriptionPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true,
              },
            },
          },
        },
        requestedBy: {
          include: {
            user: true,
          },
        },
      },
    });

    if (!existingSubscription) {
      return NextResponse.json(
        { error: "Subscription not found" },
        { status: 404 },
      );
    }

    // Check authorization: must be a participant or privileged
    const isConsultant =
      !!existingSubscription.subscriptionPlan?.consultantProfile?.id &&
      existingSubscription.subscriptionPlan.consultantProfile.id ===
        session.user.consultantProfileId;
    const isConsultee =
      !!existingSubscription.requestedById &&
      existingSubscription.requestedById === session.user.consulteeProfileId;
    if (!isPrivileged(session.user.role) && !isConsultant && !isConsultee) {
      return forbiddenResponse(
        "You can only modify subscriptions you are a participant in",
      );
    }

    // #1004 — declining is the CONSULTANT's act. The transition guard enforces
    // only the from-state, and REJECTED is legal from PENDING and
    // APPROVED_PENDING_PAYMENT, so without this the consultee could reject
    // their own paid request and collect the consultant-initiated 100% refund
    // — every notice tier bypassed, on demand.
    if (
      status === AppointmentStatus.REJECTED &&
      !isConsultant &&
      !isPrivileged(session.user.role)
    ) {
      return forbiddenResponse(
        "Only the consultant can decline a request. Cancel it instead.",
      );
    }

    if (!existingSubscription.subscriptionPlan?.consultantProfile?.user?.id) {
      return NextResponse.json(
        { error: "Invalid subscription: missing consultant information" },
        { status: 400 },
      );
    }

    if (!existingSubscription.requestedBy?.user?.id) {
      return NextResponse.json(
        { error: "Invalid subscription: missing requestedBy information" },
        { status: 400 },
      );
    }

    const startDate = new Date();
    const endDate = addMonths(
      startDate,
      existingSubscription.subscriptionPlan.durationInMonths,
    );

    // LAYER 1: Distributed lock (only for APPROVED status changes)
    let lock: ApprovalLock | null = null;
    if (status === AppointmentStatus.APPROVED) {
      try {
        lock = await lockSubscriptionApproval(
          subscriptionId,
          APPROVAL_LOCK_TTL_MS,
        ); // #1319 — must outlive the 30 s tx
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof Error ? error.message : "Failed to acquire lock",
          },
          { status: 409 }, // Conflict - another approval in progress
        );
      }
    }

    try {
      // LAYER 2: Serializable transaction with idempotency checks
      const result = await withSerializableRetry(async () => {
        // #1319 — re-grant the approval lock for this attempt; the retry loop
        // outlived the fixed grant.
        await renewApprovalLock(lock);
        return prisma.$transaction(
          async (tx) => {
            // Fetch current state inside transaction
            const currentSubscription = await tx.subscription.findUnique({
              where: { id: subscriptionId },
              include: {
                subscriptionPlan: {
                  include: {
                    consultantProfile: {
                      include: {
                        user: true,
                      },
                    },
                  },
                },
                requestedBy: {
                  include: {
                    user: true,
                  },
                },
                appointments: {
                  // Ordered so bookingOrgId's `find` picks the same org-tagged
                  // appointment the creator's filtered read picks. Unordered, two
                  // callers can resolve different orgs for one subscription and
                  // mint two DM channels for the same pair.
                  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                  include: {
                    slotsOfAppointment: {
                      include: {
                        user: true,
                      },
                    },
                  },
                },
              },
            });

            if (!currentSubscription) {
              throw new Error("Subscription not found");
            }

            // IDEMPOTENCY: Check if already in target state or processing
            if (status === AppointmentStatus.APPROVED) {
              if (
                currentSubscription.status ===
                AppointmentStatus.APPROVED_PENDING_PAYMENT
              ) {
                // Already processing, return existing state
                return {
                  data: currentSubscription,
                  message: "Approval already in progress",
                  duplicate: true,
                };
              }

              if (currentSubscription.status === AppointmentStatus.APPROVED) {
                return {
                  data: currentSubscription,
                  message: "Already approved",
                  duplicate: true,
                };
              }
            }

            // #836 — allowed-from guard rides the WHERE; the idempotency
            // pre-checks above are only friendly error text. updateMany
            // returns no row, so re-read for the heavy include.
            await transitionSubscriptionRequest(tx, {
              where: { id: subscriptionId },
              to: status,
            });
            const subscription = await tx.subscription.findUniqueOrThrow({
              where: { id: subscriptionId },
              include: {
                subscriptionPlan: {
                  include: {
                    consultantProfile: {
                      include: {
                        user: true,
                      },
                    },
                  },
                },
                requestedBy: {
                  include: {
                    user: true,
                  },
                },
                appointments: {
                  // Ordered so bookingOrgId's `find` picks the same org-tagged
                  // appointment the creator's filtered read picks. Unordered, two
                  // callers can resolve different orgs for one subscription and
                  // mint two DM channels for the same pair.
                  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                  include: {
                    slotsOfAppointment: {
                      include: {
                        user: true,
                      },
                    },
                  },
                },
              },
            });

            // If approved, check if payment exists
            if (status === AppointmentStatus.APPROVED) {
              const hasPayment = await checkSubscriptionPayment(
                tx,
                subscription.id,
              );

              if (hasPayment) {
                // Payment already exists - update scheduling dates
                await tx.subscription.update({
                  where: { id: subscriptionId },
                  data: {
                    schedulingPeriodStartsAt: startDate,
                    schedulingPeriodEndsAt: endDate,
                  },
                });

                // Confirm existing tentative appointments by setting slots to non-tentative.
                // Appointment slots are created by SlotAllocationService during checkout/allocation,
                // not by this status handler. If no appointments exist here, that's expected for
                // approval-pending-payment flows where slots get allocated after payment succeeds.
                if (
                  subscription.appointments &&
                  subscription.appointments.length > 0
                ) {
                  // RESCHEDULED rows keep their ORIGINAL startsAt; flipping them
                  // re-confirms the time the consultee asked to leave (#1169
                  // PR 2). One statement, not one per appointment — the loop
                  // multiplied round-trips against the 30s tx budget.
                  await tx.slotOfAppointment.updateMany({
                    where: {
                      appointmentId: {
                        in: subscription.appointments.map((a) => a.id),
                      },
                      completionStatus: "SCHEDULED",
                    },
                    data: { isTentative: false },
                  });
                }
                return { data: subscription, duplicate: false };
              } else {
                // No payment — record the approval now; the pay-link is minted
                // AFTER commit (#1169 PR 2). A gateway round-trip inside a
                // Serializable transaction pinned a pooled connection, could
                // blow the 30s budget, and on rollback left a live link for an
                // approval that never persisted.
                await transitionSubscriptionRequest(tx, {
                  where: { id: subscriptionId },
                  to: AppointmentStatus.APPROVED_PENDING_PAYMENT,
                  data: {
                    schedulingPeriodStartsAt: startDate,
                    schedulingPeriodEndsAt: endDate,
                  },
                });
                const updatedSubscription =
                  await tx.subscription.findUniqueOrThrow({
                    where: { id: subscriptionId },
                    include: {
                      subscriptionPlan: {
                        include: {
                          consultantProfile: {
                            include: {
                              user: true,
                            },
                          },
                        },
                      },
                      requestedBy: {
                        include: {
                          user: true,
                        },
                      },
                      appointments: {
                        // Ordered so bookingOrgId's `find` picks the same org-tagged
                        // appointment the creator's filtered read picks. Unordered, two
                        // callers can resolve different orgs for one subscription and
                        // mint two DM channels for the same pair.
                        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                        include: {
                          slotsOfAppointment: {
                            include: {
                              user: true,
                            },
                          },
                        },
                      },
                    },
                  });

                return {
                  data: updatedSubscription,
                  message: "Subscription approved. Payment link sent to user.",
                  requiresPayment: true,
                  needsPaymentLink: true,
                  duplicate: false,
                };
              }
            }

            return { data: subscription, duplicate: false };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable, // LAYER 2: Highest isolation
            maxWait: 10000, // 10 seconds
            timeout: 30000, // 30 seconds
          },
        );
      });

      // If duplicate, return early — EXCEPT an APPROVED_PENDING_PAYMENT whose
      // pay-link mint previously failed (#1169 PR 2): fall through so a
      // re-approval restores the link.
      const needsLinkRetry =
        result.duplicate &&
        result.data.status === AppointmentStatus.APPROVED_PENDING_PAYMENT &&
        !result.data.pendingPaymentUrl;
      if (result.duplicate && !needsLinkRetry) {
        return NextResponse.json({
          data: result.data,
          message: result.message,
        });
      }

      // #1169 PR 2 — mint the pay-link AFTER the transaction commits (see the
      // in-tx comment). Mint failure leaves APPROVED_PENDING_PAYMENT with no
      // link; re-approval re-enters via needsLinkRetry and reuses the PENDING
      // payment the first attempt persisted (#1181).
      let mintedLink: {
        paymentUrl: string;
        paymentAmount: number;
        paymentCurrency: string;
      } | null = null;
      if (
        ("needsPaymentLink" in result && result.needsPaymentLink) ||
        needsLinkRetry
      ) {
        // The 502 below invites a retry; the retry reuses the same PENDING
        // payment (#1181) rather than minting a parallel order — so a second
        // live link can never reach the consultee. Everything after a
        // successful mint therefore reports and continues.
        let paymentResult;
        try {
          paymentResult = await generatePaymentLinkForSubscription(
            result.data,
            // On a retry the period was already committed by the first
            // approval; recomputing it would drift the gateway metadata away
            // from the row.
            result.data.schedulingPeriodStartsAt ?? startDate,
            result.data.schedulingPeriodEndsAt ?? endDate,
          );
        } catch (linkError) {
          // #1319 review — a lapsed approval is not a retryable mint failure:
          // the dead intent's request has already been swept, so re-approving
          // would loop forever. Answer 409 and tell the consultee to re-request.
          if (linkError instanceof ApprovalWindowLapsedError) {
            return NextResponse.json(
              {
                data: result.data,
                error: linkError.message,
                requiresPayment: true,
                paymentUrl: null,
              },
              { status: 409 },
            );
          }
          Sentry.captureException(
            linkError instanceof Error
              ? linkError
              : new Error(String(linkError)),
            { tags: { subsystem: "bookings" } },
          );
          return NextResponse.json(
            {
              data: result.data,
              error:
                "The approval was recorded, but generating the payment link failed. Approve again to retry generating the link.",
              requiresPayment: true,
              paymentUrl: null,
            },
            { status: 502 },
          );
        }

        mintedLink = {
          paymentUrl: paymentResult.checkoutUrl,
          paymentAmount: paymentResult.amount,
          paymentCurrency: paymentResult.currency,
        };

        try {
          await prisma.subscription.update({
            where: { id: subscriptionId },
            data: {
              pendingPaymentUrl: paymentResult.checkoutUrl,
              requestNotes: result.data.requestNotes
                ? `${result.data.requestNotes}\n\n[System] Payment link generated and sent to user.`
                : `[System] Payment link generated and sent to user.`,
            },
          });
        } catch (persistError) {
          Sentry.captureException(
            persistError instanceof Error
              ? persistError
              : new Error(String(persistError)),
            { tags: { subsystem: "bookings" } },
          );
          console.error(
            `⚠️ Failed to persist payment link for subscription ${subscriptionId}:`,
            persistError instanceof Error
              ? persistError.message
              : "Unknown error",
          );
        }

        try {
          await sendPaymentLinkEmail({
            email: result.data.requestedBy.user.email || "",
            name: result.data.requestedBy.user.name || "User",
            consultantName:
              result.data.subscriptionPlan.consultantProfile.user.name ||
              "Consultant",
            appointmentType: "subscription" as const,
            amount: paymentResult.amount,
            currency: paymentResult.currency,
            paymentUrl: paymentResult.checkoutUrl,
            expiresAt: new Date(Date.now() + APPROVAL_PAYMENT_EXPIRATION_MS),
          });
          console.log(
            `📧 Payment link email sent for subscription ${subscriptionId}`,
          );
        } catch (emailError) {
          Sentry.captureException(
            emailError instanceof Error
              ? emailError
              : new Error(String(emailError)),
            { tags: { subsystem: "bookings" } },
          );
          console.error(
            `⚠️ Failed to send payment link email for subscription ${subscriptionId}:`,
            emailError instanceof Error ? emailError.message : "Unknown error",
          );
        }
      }

      // #1004 — a rejected request that was already paid for has to give the
      // money back. Direct checkout captures BEFORE the request exists, so the
      // consultant is declining a booking the buyer has already paid; REJECTED
      // is terminal and the cancel route refuses it, so this is the only exit.
      // Runs after the transition commits — the allowed-from guard on that
      // transition is what makes it at-most-once.
      let rejectionRefund: Awaited<ReturnType<typeof refundRejectedRequest>> =
        null;
      if (!result.duplicate && status === AppointmentStatus.REJECTED) {
        rejectionRefund = await refundRejectedRequest({
          kind: "subscription",
          requestId: subscriptionId,
          initiatedByUserId: session.user.id,
          actor: isConsultant ? "CONSULTANT" : "PLATFORM",
        });
      }

      // Fire-and-forget: send Novu notifications for non-duplicate status changes
      if (!result.duplicate && "data" in result && result.data) {
        const subData = result.data;
        const consulteeUserId = subData.requestedBy?.user?.id;
        const consultantUserId =
          subData.subscriptionPlan?.consultantProfile?.user?.id;

        if (status === AppointmentStatus.APPROVED && consulteeUserId) {
          void notifySubscriptionStarted(consulteeUserId, {
            subscriptionId: subData.id,
            planTitle: subData.subscriptionPlan?.title || "Subscription",
            consultantName:
              subData.subscriptionPlan?.consultantProfile?.user?.name ||
              "Consultant",
            consulteeName: subData.requestedBy?.user?.name || undefined,
            dashboardUrl: "/dashboard",
          });
        }

        if (status === AppointmentStatus.CANCELLED) {
          const userIds = [consultantUserId, consulteeUserId].filter(
            (id): id is string => !!id,
          );
          if (userIds.length > 0) {
            void notifySubscriptionCancelled(userIds, {
              subscriptionId: subData.id,
              planTitle: subData.subscriptionPlan?.title || "Subscription",
              consultantName:
                subData.subscriptionPlan?.consultantProfile?.user?.name ||
                "Consultant",
              consulteeName: subData.requestedBy?.user?.name || undefined,
              dashboardUrl: "/dashboard",
            });
          }

          // Log cancellation activity (awaited — DB write should not be dropped in serverless)
          const cpId = subData.subscriptionPlan?.consultantProfileId;
          if (cpId) {
            await logSubscriptionCancelled(
              cpId,
              subData.id,
              {
                id: session.user.id,
                name: session.user.name || "User",
                image: session.user.image,
              },
              subData.subscriptionPlan?.title || "Subscription",
              session.user.id === consultantUserId ? "consultant" : "consultee",
            );
          }
        }
      }

      // --- Stream channel creation (fire-and-forget, after transaction) ---
      if (
        !result.duplicate &&
        status === AppointmentStatus.APPROVED &&
        "data" in result &&
        result.data
      ) {
        try {
          const subData = result.data;
          const consultantUid =
            subData.subscriptionPlan?.consultantProfile?.user?.id;
          const consulteeUid = subData.requestedBy?.user?.id;

          if (consultantUid && consulteeUid) {
            // #1134 P0-7 / P0-8 — see the consultation twin. No
            // `subscription-<id>` channel (the reconciler deleted it on the next
            // load), and the org is threaded so the DM key matches what
            // getDmPairsForUser expects.
            // A subscription carries many appointments but is funded once, so
            // the first ORG-TAGGED one is representative. `[0]` was wrong: this
            // query has no `where` and no `orderBy`, so a mixed subscription
            // could hand back a personal row and resolve `null` where the
            // creator resolved an org — two different channel ids for one pair.
            const dmOrgId = bookingOrgId(subData);
            await createDirectMessageChannel(
              consultantUid,
              consulteeUid,
              dmOrgId,
            );
            streamLogger.info(
              "Stream DM channel ensured on subscription approval",
              { subscriptionId: subData.id, organizationId: dmOrgId },
            );
          }
        } catch (channelError) {
          Sentry.captureException(
            channelError instanceof Error
              ? channelError
              : new Error(String(channelError)),
            { tags: { subsystem: "bookings" } },
          );
          streamLogger.error(
            "Auto-channel creation failed on subscription approval",
            channelError,
            { subscriptionId },
          );
        }
      }

      // Return success response (exclude emailData from response)
      return NextResponse.json({
        ...result,
        ...mintedLink,
        refund: rejectionRefund,
      });
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "bookings" } },
      );
      console.error(
        "Transaction error:",
        error instanceof Error ? error.message : "Unknown error",
      );
      throw error;
    } finally {
      // LAYER 1: Always release lock
      if (lock) {
        await unlockApproval(lock);
      }
    }
  } catch (error) {
    if (error instanceof ApprovalLockLostError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    if (error instanceof IllegalTransitionError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error(
      "Error updating subscription:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return NextResponse.json(
      { error: "An error occurred while updating subscription" },
      { status: 500 },
    );
  }
}

/**
 * Check if payment exists for this subscription
 * Uses transaction client to maintain serializable isolation
 */
async function checkSubscriptionPayment(
  tx: Tx,
  subscriptionId: string,
): Promise<boolean> {
  const subscription = await tx.subscription.findUnique({
    where: { id: subscriptionId },
    include: {
      appointments: {
        include: {
          payment: {
            where: {
              paymentStatus: {
                in: [PaymentStatus.SUCCEEDED, PaymentStatus.PENDING],
              },
            },
          },
        },
      },
    },
  });

  return (
    subscription?.appointments?.some((apt) => (apt.payment?.length ?? 0) > 0) ??
    false
  );
}

/**
 * Generate payment link for approved subscription
 */
async function generatePaymentLinkForSubscription(
  subscription: SubscriptionWithDetails,
  schedulingPeriodStartsAt: Date,
  schedulingPeriodEndsAt: Date,
) {
  const { subscriptionPlan, requestedBy } = subscription;
  // #1181 — the request-time appointment (direct checkout creates a
  // placeholder for exactly this linkage; proposed-times creates real rows).
  // First under the route's deterministic createdAt/id ordering, the same row
  // the confirm flip and org resolution read. Threading it stamps
  // Payment.appointmentId so capture confirms THAT row instead of building a
  // twin subscription off metadata, and the duplicate-payment guard (which
  // walks appointments.payment) can see approval payments at all. Unset only
  // when no appointment exists yet — nothing to confirm, mint as before.
  const appointmentId = subscription.appointments[0]?.id ?? undefined;

  return await createApprovalPaymentIntent({
    userId: requestedBy.user.id,
    appointmentType: "SUBSCRIPTION",
    subscriptionId: subscription.id,
    appointmentId,
    planId: subscriptionPlan.id,
    // #1165 — settlement is INR-only; Razorpay is the KYC'd primary gateway,
    // matching the trial path. Param stays configurable for a scale decision.
    paymentGateway: PaymentGateway.RAZORPAY,
    // #1166 ORG-9 — carry org sponsorship when an org-tagged appointment
    // already exists on the request.
    organizationId:
      subscription.appointments?.find((a) => a.organizationId)
        ?.organizationId ?? undefined,
    schedulingPeriodStartsAt: schedulingPeriodStartsAt.toISOString(),
    schedulingPeriodEndsAt: schedulingPeriodEndsAt.toISOString(),
    notes: subscription.requestNotes ?? undefined,
  });
}
