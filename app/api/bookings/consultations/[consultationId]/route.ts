import * as Sentry from "@sentry/nextjs";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import prisma, { type Tx } from "@/lib/prisma";
import {
  PaymentGateway,
  PaymentStatus,
  Prisma,
  AppointmentStatus,
} from "@prisma/client";
import { z } from "zod";
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
  lockConsultationApproval,
  renewApprovalLock,
  unlockApproval,
} from "@/utils/appointmentlock";
import { transitionConsultationRequest } from "@/lib/booking/transitions";
import { refundRejectedRequest } from "@/lib/booking/rejection-refund";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { MAX_TEXT_LENGTH } from "@/lib/validation/limits";
import { sendPaymentLinkEmail } from "@/lib/email";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { createDirectMessageChannel } from "@/actions/stream/chat/channel.action";
import { streamLogger } from "@/lib/stream-logger";
import { bookingOrgId } from "@/lib/stream-utils";
import { reportSentryError } from "@/lib/observability/report";

/**
 * Type for consultation with all related details needed for payment processing.
 * Derived via the extended client — raw GetPayload would re-introduce bigint
 * money fields (#780).
 */
type ConsultationWithDetails = Prisma.Result<
  typeof prisma.consultation,
  {
    include: {
      consultationPlan: {
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
      appointment: {
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
  request: Request,
  { params }: { params: Promise<{ consultationId: string }> },
) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const { consultationId } = await params;
    const consultationData = await prisma.consultation.findUniqueOrThrow({
      where: { id: consultationId },
      include: {
        consultationPlan: {
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
        appointment: {
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
    const consultantProfileId =
      consultationData.consultationPlan?.consultantProfile?.id;
    const consulteeProfileId = consultationData.requestedBy?.id;
    const isConsultant =
      !!consultantProfileId &&
      consultantProfileId === session.user.consultantProfileId;
    const isConsultee =
      !!consulteeProfileId &&
      consulteeProfileId === session.user.consulteeProfileId;
    const isParticipant = isConsultant || isConsultee;

    if (!isPrivileged(session.user.role) && !isParticipant) {
      return forbiddenResponse(
        "You can only view consultations you are a participant in",
      );
    }

    return NextResponse.json({ data: consultationData }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Consultation not found" },
        { status: 404 },
      );
    }
    console.error("Error fetching consultation:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    return NextResponse.json(
      { error: "An error occurred while fetching the consultation" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ consultationId: string }> },
) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const { consultationId } = await params;

    // Fetch the consultation to check ownership
    const existingConsultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
      include: {
        consultationPlan: {
          include: {
            consultantProfile: true,
          },
        },
      },
    });

    if (!existingConsultation) {
      return NextResponse.json(
        { error: "Consultation not found" },
        { status: 404 },
      );
    }

    // Check authorization: must be a participant or privileged
    const isConsultant =
      !!existingConsultation.consultationPlan?.consultantProfile?.id &&
      existingConsultation.consultationPlan.consultantProfile.id ===
        session.user.consultantProfileId;
    const isConsultee =
      !!existingConsultation.requestedById &&
      existingConsultation.requestedById === session.user.consulteeProfileId;
    const isParticipant = isConsultant || isConsultee;

    if (!isPrivileged(session.user.role) && !isParticipant) {
      return forbiddenResponse(
        "You can only update consultations you are a participant in",
      );
    }

    const body = await request.json();

    // Validate body to prevent arbitrary field injection
    // #836 — status is NOT writable here: status changes flow only
    // through PATCH, where the allowed-from guard rides the WHERE clause.
    // #831 — user-typed strings carry a .max()
    const consultationPutSchema = z
      .object({
        requestNotes: z.string().max(MAX_TEXT_LENGTH).nullish(),
        bookingSource: z
          .enum(["DIRECT_CHECKOUT", "REQUEST_SUBMITTED"])
          .optional(),
        feedbackFromConsultee: z.string().max(MAX_TEXT_LENGTH).nullish(),
        feedbackFromConsultant: z.string().max(MAX_TEXT_LENGTH).nullish(),
        rating: z.number().min(1).max(5).nullish(),
        planId: z.string().optional(),
      })
      .strict();

    const parseResult = consultationPutSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        {
          error: "Invalid request body",
          details: parseResult.error.flatten().fieldErrors,
        },
        { status: 400 },
      );
    }
    const validatedBody = parseResult.data;

    const consultationData = await prisma.consultation.update({
      where: { id: consultationId },
      data: {
        requestNotes: validatedBody.requestNotes,
        bookingSource: validatedBody.bookingSource,
        feedbackFromConsultee: validatedBody.feedbackFromConsultee,
        feedbackFromConsultant: validatedBody.feedbackFromConsultant,
        rating: validatedBody.rating,
        consultationPlan: validatedBody.planId
          ? {
              connect: { id: validatedBody.planId },
            }
          : undefined,
      },
      include: {
        consultationPlan: {
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
        appointment: {
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

    return NextResponse.json({ data: consultationData }, { status: 200 });
  } catch (error) {
    console.error("Error updating consultation:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    return NextResponse.json(
      { error: "An error occurred while updating the consultation" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ consultationId: string }> },
) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;

    // Doctrine rule 2 — nothing is deleted. This route used to run a raw
    // `prisma.consultation.delete`, whose cascades reach the Appointment and
    // from there every Payment pointing at it (Payment.appointment onDelete:
    // Cascade) — hard-destroying financial rows. Bookings are soft-cancelled
    // through the cancel API, which also routes any refund through the front
    // door (lib/payments/operations/booking-refund.ts).
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
  } catch (error) {
    console.error("Error deleting consultation:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    return NextResponse.json(
      { error: "An error occurred while deleting the consultation" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ consultationId: string }> },
) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const body = await request.json();
    const { consultationId } = await params;

    const consultationPatchSchema = z.object({
      status: z.nativeEnum(AppointmentStatus),
    });

    const parseResult = consultationPatchSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parseResult.error.format() },
        { status: 400 },
      );
    }

    const { status } = parseResult.data;

    // First fetch the consultation to validate it exists and get all necessary data
    const existingConsultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
      include: {
        consultationPlan: {
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

    if (!existingConsultation) {
      return NextResponse.json(
        { error: "Consultation not found" },
        { status: 404 },
      );
    }

    if (!existingConsultation.consultationPlan?.consultantProfile?.user?.id) {
      return NextResponse.json(
        { error: "Invalid consultation: missing consultant information" },
        { status: 400 },
      );
    }

    if (!existingConsultation.requestedBy?.user?.id) {
      return NextResponse.json(
        { error: "Invalid consultation: missing requestedBy information" },
        { status: 400 },
      );
    }

    // Check authorization: must be a participant or privileged
    const isConsultant =
      !!existingConsultation.consultationPlan?.consultantProfile?.id &&
      existingConsultation.consultationPlan.consultantProfile.id ===
        session.user.consultantProfileId;
    const isConsultee =
      !!existingConsultation.requestedById &&
      existingConsultation.requestedById === session.user.consulteeProfileId;
    const isParticipant = isConsultant || isConsultee;

    if (!isPrivileged(session.user.role) && !isParticipant) {
      return forbiddenResponse(
        "You can only update consultations you are a participant in",
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

    // LAYER 1: Distributed lock (only for APPROVED status changes)
    let lock: ApprovalLock | null = null;
    if (status === AppointmentStatus.APPROVED) {
      try {
        lock = await lockConsultationApproval(
          consultationId,
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
            const currentConsultation = await tx.consultation.findUnique({
              where: { id: consultationId },
              include: {
                consultationPlan: {
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
                appointment: {
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

            if (!currentConsultation) {
              throw new Error("Consultation not found");
            }

            // IDEMPOTENCY: Check if already in target state or processing
            if (status === AppointmentStatus.APPROVED) {
              if (
                currentConsultation.status ===
                AppointmentStatus.APPROVED_PENDING_PAYMENT
              ) {
                // Already processing, return existing state
                return {
                  data: currentConsultation,
                  message: "Approval already in progress",
                  duplicate: true,
                };
              }

              if (currentConsultation.status === AppointmentStatus.APPROVED) {
                return {
                  data: currentConsultation,
                  message: "Already approved",
                  duplicate: true,
                };
              }
            }

            // #836 — allowed-from guard rides the WHERE; the idempotency
            // pre-checks above are only friendly error text. updateMany
            // returns no row, so re-read for the heavy include.
            await transitionConsultationRequest(tx, {
              where: { id: consultationId },
              to: status,
            });
            const consultation = await tx.consultation.findUniqueOrThrow({
              where: { id: consultationId },
              include: {
                consultationPlan: {
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
                appointment: {
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
              const hasPayment = await checkConsultationPayment(
                tx,
                consultation.id,
              );

              if (hasPayment) {
                // Payment already exists - check if tentative appointment exists
                if (consultation.appointment) {
                  // Confirm existing tentative appointment. RESCHEDULED rows are
                  // excluded (#1169 PR 2): they keep their ORIGINAL startsAt, so
                  // flipping them re-confirms exactly the time the consultee
                  // asked to move away from.
                  await tx.slotOfAppointment.updateMany({
                    where: {
                      appointmentId: consultation.appointment.id,
                      completionStatus: "SCHEDULED",
                    },
                    data: { isTentative: false },
                  });
                } else {
                  // Paid but no appointment row: the capture webhook that
                  // creates the appointment has not landed (or died mid-flight).
                  // The old fallback fabricated a confirmed slot at now+1h on
                  // the GLOBAL client — no availability check, no lock, no
                  // consultantProfileId, and it survived this transaction's
                  // rollback (#1169 PR 2 / CORE-3). Refuse instead: the
                  // reconcile-orphaned-confirmations sweep (#830) settles this
                  // exact state, after which approval succeeds normally.
                  throw new PaidWithoutAppointmentError(consultation.id);
                }
                return { data: consultation, duplicate: false };
              } else {
                // No payment — record the approval now; the pay-link is minted
                // AFTER commit (#1169 PR 2). A gateway round-trip inside a
                // Serializable transaction pinned a pooled connection for
                // seconds, could blow the 30s budget, and on rollback left a
                // live payment link for an approval that never persisted. The
                // trial path documents the same rule.
                await transitionConsultationRequest(tx, {
                  where: { id: consultationId },
                  to: AppointmentStatus.APPROVED_PENDING_PAYMENT,
                });
                const updatedConsultation =
                  await tx.consultation.findUniqueOrThrow({
                    where: { id: consultationId },
                    include: {
                      consultationPlan: {
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
                      appointment: {
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
                  data: updatedConsultation,
                  message: "Consultation approved. Payment link sent to user.",
                  requiresPayment: true,
                  needsPaymentLink: true,
                  duplicate: false,
                };
              }
            }

            return { data: consultation, duplicate: false };
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
      // re-approval restores the link instead of parroting
      // "already in progress" forever.
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

      // #1004 — a rejected request that was already paid for has to give the
      // money back. Direct checkout captures BEFORE the request exists, so the
      // consultant is declining a booking the buyer has already paid; REJECTED
      // is terminal and the cancel route refuses it, so this is the only exit.
      // Runs after the transition commits — the allowed-from guard on that
      // transition is what makes it at-most-once.
      const rejectionRefund =
        status === AppointmentStatus.REJECTED
          ? await refundRejectedRequest({
              kind: "consultation",
              requestId: consultationId,
              initiatedByUserId: session.user.id,
              actor: isConsultant ? "CONSULTANT" : "PLATFORM",
            })
          : null;

      // #1169 PR 2 — mint the pay-link AFTER the transaction commits (see the
      // in-tx comment for why). On mint failure the consultation stays
      // APPROVED_PENDING_PAYMENT with no link — the same failure mode the
      // trial path chose — and the consultant is told to retry the approval,
      // which re-enters here idempotently.
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
        // successful mint therefore reports and continues: a 502 past this
        // point would still be wrong, because it reads as a failure the
        // consultant should answer by re-approving.
        let paymentResult;
        try {
          paymentResult = await generatePaymentLink(result.data);
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
          await prisma.consultation.update({
            where: { id: consultationId },
            data: {
              pendingPaymentUrl: paymentResult.checkoutUrl,
              requestNotes: result.data.requestNotes
                ? `${result.data.requestNotes}\n\n[System] Payment link generated and sent to user.`
                : `[System] Payment link generated and sent to user.`,
            },
          });
        } catch (persistError) {
          // The link is live and rides the response + email; only the
          // dashboard copy is missing.
          console.error(
            `⚠️ Failed to persist payment link for consultation ${consultationId}:`,
            persistError instanceof Error
              ? persistError.message
              : "Unknown error",
          );
          Sentry.captureException(
            persistError instanceof Error
              ? persistError
              : new Error(String(persistError)),
            { tags: { subsystem: "bookings" } },
          );
        }

        try {
          await sendPaymentLinkEmail({
            email: result.data.requestedBy.user.email || "",
            name: result.data.requestedBy.user.name || "User",
            consultantName:
              result.data.consultationPlan.consultantProfile.user.name ||
              "Consultant",
            appointmentType: "consultation" as const,
            amount: paymentResult.amount,
            currency: paymentResult.currency,
            paymentUrl: paymentResult.checkoutUrl,
            expiresAt: new Date(Date.now() + APPROVAL_PAYMENT_EXPIRATION_MS),
          });
          console.log(
            `📧 Payment link email sent for consultation ${consultationId}`,
          );
        } catch (emailError) {
          // Link exists on the dashboard via pendingPaymentUrl; email is
          // best-effort.
          console.error(
            `⚠️ Failed to send payment link email for consultation ${consultationId}:`,
            emailError instanceof Error ? emailError.message : "Unknown error",
          );
          Sentry.captureException(
            emailError instanceof Error
              ? emailError
              : new Error(String(emailError)),
            { tags: { subsystem: "bookings" } },
          );
        }
      }

      // --- Stream channel creation (fire-and-forget, only on approval) ---
      if (!result.duplicate && status === AppointmentStatus.APPROVED) {
        try {
          const consultationData = result.data;
          const consultantUserId =
            consultationData.consultationPlan?.consultantProfile?.userId;
          const consulteeUserId = consultationData.requestedBy?.userId;

          if (consultantUserId && consulteeUserId) {
            // #1134 P0-7 — no more `consultation-<id>` channel: the reconcile
            // pass never expected it yet treated its prefix as managed, so it
            // was deleted on the buyer's next dashboard load. #1134 P0-8 — the
            // org must be threaded so the DM lands on the key the reconciler
            // expects — via the one shared resolver, so it cannot drift.
            const dmOrgId = bookingOrgId(consultationData);
            await createDirectMessageChannel(
              consultantUserId,
              consulteeUserId,
              dmOrgId,
            );
            streamLogger.info(
              "Stream DM channel ensured on consultation approval",
              { consultationId, organizationId: dmOrgId },
            );
          }
        } catch (channelError) {
          // The subscription twin reports this and the payment-success handler
          // pages on it: a failure here leaves the buyer with no chat at all,
          // and a log line alone means nobody finds out.
          reportSentryError(channelError, {
            subsystem: "stream",
            op: "consultationApproval.createChannels",
            extra: { consultationId },
          });
          streamLogger.error(
            "Auto-channel creation failed on consultation approval",
            channelError,
            { consultationId },
          );
        }
      }

      // Return success response
      return NextResponse.json({
        ...result,
        ...mintedLink,
        refund: rejectionRefund,
      });
    } catch (error) {
      console.error(
        "Transaction error:",
        error instanceof Error ? error.message : "Unknown error",
      );
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "bookings" } },
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
    if (error instanceof PaidWithoutAppointmentError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error(
      "Error updating consultation:",
      error instanceof Error ? error.message : "Unknown error",
    );
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    return NextResponse.json(
      { error: "An error occurred while updating consultation" },
      { status: 500 },
    );
  }
}

// #1169 PR 2 — thrown inside the approval transaction so the APPROVED
// transition rolls back; mapped to a 409 that names the reconciliation path.
class PaidWithoutAppointmentError extends Error {
  constructor(readonly consultationId: string) {
    super(
      "This consultation is paid but its appointment has not been created yet (the payment confirmation is still being processed). The reconciliation sweep completes it within minutes — approve again after that.",
    );
    this.name = "PaidWithoutAppointmentError";
  }
}

/**
 * Check if payment exists for this consultation
 * Uses transaction client to maintain serializable isolation
 */
async function checkConsultationPayment(
  tx: Tx,
  consultationId: string,
): Promise<boolean> {
  const consultation = await tx.consultation.findUnique({
    where: { id: consultationId },
    include: {
      appointment: {
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

  return (consultation?.appointment?.payment?.length ?? 0) > 0;
}

/**
 * Generate payment link for approved consultation
 */
async function generatePaymentLink(consultation: ConsultationWithDetails) {
  const { consultationPlan, requestedBy, appointment } = consultation;

  // Extract slot times if appointment/slots exist
  const slot = appointment?.slotsOfAppointment?.[0];
  const startsAt = slot?.startsAt?.toISOString();
  const endsAt = slot?.endsAt?.toISOString();

  return await createApprovalPaymentIntent({
    userId: requestedBy.user.id,
    appointmentType: "CONSULTATION",
    consultationId: consultation.id,
    // #1181 — the request created this appointment at submit time; threading
    // it stamps Payment.appointmentId so capture confirms THAT row instead of
    // building a twin off metadata, and the duplicate-payment guard (which
    // walks appointment.payment) can see approval payments at all.
    appointmentId: appointment?.id ?? undefined,
    planId: consultationPlan.id,
    // #1165 — settlement is INR-only and Razorpay is the KYC'd primary
    // gateway; the trial path already minted on it. Param stays configurable
    // for a future scale decision.
    paymentGateway: PaymentGateway.RAZORPAY,
    // #1166 ORG-9 — org sponsorship survives the approval flow: the request
    // stamped the appointment, and the payment carries it from there.
    organizationId: appointment?.organizationId ?? undefined,
    startsAt,
    endsAt,
    notes: consultation.requestNotes ?? undefined,
  });
}

// (removed) createAppointmentForConsultation — #1169 PR 2 / CORE-3.
// It fabricated a confirmed slot at now+1h with no availability check, no
// lock, no consultantProfileId, using the GLOBAL client from inside the
// Serializable approval transaction (the row survived rollback). The paid-
// without-appointment state it papered over is settled by
// scripts/payments/reconcile-orphaned-confirmations.ts (#830); the approval
// route now refuses with PaidWithoutAppointmentError instead.
