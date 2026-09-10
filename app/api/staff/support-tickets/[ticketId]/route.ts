/**
 * Staff Support Ticket Detail API
 * Get ticket details and update ticket (status, priority, assignment)
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import { Prisma, UserRole } from "@prisma/client";
import { notifySupportTicketUpdate } from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { UpdateSupportTicketSchema } from "@/schemas/support";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import * as Sentry from "@sentry/nextjs";
interface RouteParams {
  params: Promise<{ ticketId: string }>;
}

/**
 * GET /api/staff/support-tickets/[ticketId]
 * Get full ticket details with responses, attachments, and linked entities
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { ticketId } = await params;

    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
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
        responses: {
          orderBy: { createdAt: "asc" },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                image: true,
                role: true,
              },
            },
          },
        },
        attachments: {
          orderBy: { uploadedAt: "desc" },
        },
        // #support-hub — the escalated-from thread, transcript included: staff
        // are the HUMAN channel's counterparty, so the conversation is theirs
        // to read (unlike the org triage surface, which is metadata-only).
        appointmentSupportThread: {
          select: {
            id: true,
            category: true,
            status: true,
            activeChannel: true,
            createdAt: true,
            lastMessageAt: true,
            messages: {
              // Newest 50, re-ordered ascending below — the ticket page needs
              // a bounded preview, not the whole transcript; the dedicated
              // thread route serves full history.
              orderBy: { createdAt: "desc" },
              take: 50,
              select: { id: true, sender: true, body: true, createdAt: true },
            },
          },
        },
      },
    });

    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    // Fetch linked entities in parallel for better performance
    const [
      linkedConsultation,
      linkedSubscription,
      linkedPayment,
      linkedRefund,
    ] = await Promise.all([
      ticket.consultationId
        ? prisma.consultation.findUnique({
            where: { id: ticket.consultationId },
            include: {
              consultationPlan: {
                select: {
                  title: true,
                  price: true,
                  priceCurrency: true,
                  // #946 allowlist — a bare `include:` handed every staff
                  // member opening a ticket the consultant's panNumber and
                  // ibanOrAccount.
                  consultantProfile: {
                    select: {
                      ...consultantPublicScalars,
                      user: { select: { name: true, email: true } },
                    },
                  },
                },
              },
              appointment: {
                select: {
                  id: true,
                  slotsOfAppointment: {
                    select: {
                      startsAt: true,
                    },
                    orderBy: {
                      startsAt: "asc",
                    },
                    take: 1,
                  },
                },
              },
            },
          })
        : Promise.resolve(null),
      ticket.subscriptionId
        ? prisma.subscription.findUnique({
            where: { id: ticket.subscriptionId },
            include: {
              subscriptionPlan: {
                select: {
                  title: true,
                  price: true,
                  priceCurrency: true,
                  // #946 allowlist — a bare `include:` handed every staff
                  // member opening a ticket the consultant's panNumber and
                  // ibanOrAccount.
                  consultantProfile: {
                    select: {
                      ...consultantPublicScalars,
                      user: { select: { name: true, email: true } },
                    },
                  },
                },
              },
            },
          })
        : Promise.resolve(null),
      ticket.paymentId
        ? prisma.payment.findUnique({
            where: { id: ticket.paymentId },
            select: {
              id: true,
              amount: true,
              currency: true,
              paymentStatus: true,
              paymentGateway: true,
              createdAt: true,
            },
          })
        : Promise.resolve(null),
      ticket.refundId
        ? prisma.refund.findUnique({
            where: { id: ticket.refundId },
            select: {
              id: true,
              amountPaise: true,
              currency: true,
              status: true,
              reason: true,
              createdAt: true,
            },
          })
        : Promise.resolve(null),
    ]);

    return NextResponse.json({
      ...ticket,
      // Transcript was fetched newest-50 for the bound; hand it back oldest-
      // first, the ascending shape the page has always rendered.
      ...(ticket.appointmentSupportThread
        ? {
            appointmentSupportThread: {
              ...ticket.appointmentSupportThread,
              messages: [...ticket.appointmentSupportThread.messages].reverse(),
            },
          }
        : {}),
      linkedConsultation,
      linkedSubscription,
      linkedPayment,
      linkedRefund,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    console.error("Error fetching support ticket:", error);
    return NextResponse.json(
      { error: "Failed to fetch support ticket" },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/staff/support-tickets/[ticketId]
 * Update ticket status, priority, or assignment
 */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { ticketId } = await params;
    const body = await req.json();
    const result = UpdateSupportTicketSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }
    const validatedData = result.data;

    // Validate ticket exists
    const existingTicket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
    });

    if (!existingTicket) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    // Build update data
    const updateData: Prisma.SupportTicketUpdateInput = {};

    if (validatedData.status) {
      updateData.status = validatedData.status;
    }

    if (validatedData.priority) {
      updateData.priority = validatedData.priority;
    }

    if (validatedData.assignedToId !== undefined) {
      // Validate assignee is staff/admin if not null
      if (validatedData.assignedToId !== null) {
        const assignee = await prisma.user.findUnique({
          where: { id: validatedData.assignedToId },
          select: { role: true },
        });

        if (
          !assignee ||
          (assignee.role !== UserRole.STAFF && assignee.role !== UserRole.ADMIN)
        ) {
          return NextResponse.json(
            { error: "Invalid assignee - must be staff or admin" },
            { status: 400 },
          );
        }
      }
      // #705 — assignedToId is now a real relation, so an unchecked update goes
      // through connect/disconnect. The validation above is what keeps the FK
      // satisfiable; this just expresses the same write.
      updateData.assignedTo =
        validatedData.assignedToId === null
          ? { disconnect: true }
          : { connect: { id: validatedData.assignedToId } };
    }

    // Link to refund if provided
    if (validatedData.refundId) {
      updateData.refundId = validatedData.refundId;
    }

    // The ticket and its linked thread move together or not at all. Sequential
    // writes let the thread update fail after the ticket had already committed,
    // leaving the queue and the user's conversation disagreeing about status
    // while the route answered 500 — so the caller retried against a ticket
    // that had in fact already moved.
    const updatedTicket = await prisma.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.update({
        where: { id: ticketId },
        data: updateData,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      });

      // #support-hub — mirror terminal statuses to the linked per-appointment
      // thread so the user's conversation never disagrees with the queue.
      // ON_HOLD has no thread equivalent (the thread stays ESCALATED); CAS on
      // both sides: a thread already CLOSED stays closed.
      if (
        validatedData.status &&
        validatedData.status !== "ON_HOLD" &&
        validatedData.status !== "OPEN"
      ) {
        // CLOSED is guarded UNCONDITIONALLY — a status-conditional notIn array
        // (e.g. [] for RESOLVED) is a no-op filter in Prisma and could clobber
        // a thread a staff member already closed.
        await tx.appointmentSupportThread.updateMany({
          where: {
            supportTicketId: ticketId,
            status: { notIn: ["CLOSED"] },
          },
          data: {
            status: validatedData.status,
            // RESOLVED stamps the clock, re-open clears it, CLOSED keeps it —
            // same semantics as the thread route's own PATCH.
            ...(validatedData.status === "RESOLVED"
              ? { resolvedAt: new Date() }
              : {}),
            ...(validatedData.status === "IN_PROGRESS"
              ? { resolvedAt: null }
              : {}),
          },
        });
      }
      return ticket;
    });

    // After the commit — a notification failure must not roll back a status
    // change the queue has already acted on.
    // Notify the ticket owner about the update
    void notifySupportTicketUpdate(updatedTicket.user.id, {
      ticketId: updatedTicket.id,
      ticketTitle: updatedTicket.title || "Support Ticket",
      status: updatedTicket.status,
      dashboardUrl: "/dashboard",
      // ADR 23 — inherit the ticket's org-ness (attribution only).
      ...notificationScope(updatedTicket.organizationId),
    });

    return NextResponse.json(updatedTicket);
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    console.error("Error updating support ticket:", error);
    return NextResponse.json(
      { error: "Failed to update support ticket" },
      { status: 500 },
    );
  }
}
