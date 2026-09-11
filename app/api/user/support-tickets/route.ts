import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  createSupportTicket,
  findOpenTicketForPayment,
  isSessionScopedIssueType,
} from "@/lib/support/create-ticket";
import { CreateSupportTicketSchema } from "@/schemas/support";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";

import { getSession } from "@/lib/auth-server";
import { assertBodySize } from "@/lib/validation/limits";
import { supportError } from "@/lib/api/support-http";

const TICKETS_ROUTE = "user.support-tickets";

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return supportError({ status: 401, code: "UNAUTHORIZED" });
    }

    const tickets = await prisma.supportTicket.findMany({
      where: {
        userId: session.user.id,
      },
      include: {
        responses: {
          where: {
            isInternal: false, // Don't show internal notes to users
          },
          orderBy: {
            createdAt: "asc",
          },
          include: {
            user: {
              select: {
                name: true,
                role: true,
              },
            },
          },
        },
        attachments: {
          orderBy: {
            uploadedAt: "desc",
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json(tickets);
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: TICKETS_ROUTE, action: "list" },
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return supportError({ status: 401, code: "UNAUTHORIZED" });
    }

    // Rate limit: 5 support tickets per hour per user
    const rl = await applyRateLimit(spamLimiter, `tickets:${session.user.id}`);
    if (rl) return rl;

    // #831 — cap request body before parsing
    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const body = await req.json();
    const result = CreateSupportTicketSchema.safeParse(body);
    if (!result.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: result.error.flatten(),
        context: { route: TICKETS_ROUTE, action: "create" },
      });
    }
    const validatedData = result.data;

    // #support-hub — session-scoped issue types don't belong on the platform
    // queue. "Consultant didn't show up", cancellation help, etc. are
    // appointment-specific: the user picks the session and the per-appointment
    // flowchart thread routes it with full context. 422 (well-formed but
    // semantically misrouted) with guidance instead of a silent accept.
    if (isSessionScopedIssueType(validatedData.issueType)) {
      return NextResponse.json(
        {
          error:
            "This issue is about a specific session — open the appointment and use 'Get help' so our team gets the session context.",
          code: "SESSION_SCOPED_ISSUE",
        },
        { status: 422 },
      );
    }

    // Resolve appointmentId to consultationId/subscriptionId if provided.
    //
    // When an appointmentId IS given, the client's own consultationId /
    // subscriptionId are DISCARDED rather than kept as fallbacks. Keeping them
    // was an ownership hole: the validation block below skips its checks
    // whenever `appointmentId` is present ("already validated above"), but the
    // appointment only ever resolves ONE arm — so a caller could pass their own
    // consultation appointment together with somebody else's subscriptionId and
    // have it attached to their ticket unchecked. The appointment is the single
    // source of truth for the link, or there is no link.
    let resolvedConsultationId = validatedData.appointmentId
      ? undefined
      : validatedData.consultationId;
    let resolvedSubscriptionId = validatedData.appointmentId
      ? undefined
      : validatedData.subscriptionId;

    if (validatedData.appointmentId) {
      const appointment = await prisma.appointment.findFirst({
        where: {
          id: validatedData.appointmentId,
          OR: [
            { consultation: { requestedBy: { userId: session.user.id } } },
            { subscription: { requestedBy: { userId: session.user.id } } },
          ],
        },
        include: {
          consultation: true,
          subscription: true,
        },
      });

      if (!appointment) {
        return supportError({
          status: 400,
          code: "INVALID_ID",
          message: "Invalid appointment ID or unauthorized",
          context: {
            route: TICKETS_ROUTE,
            action: "create",
            appointmentId: validatedData.appointmentId,
          },
        });
      }

      // Resolve to actual consultation/subscription IDs
      if (appointment.consultation) {
        resolvedConsultationId = appointment.consultation.id;
      } else if (appointment.subscription) {
        resolvedSubscriptionId = appointment.subscription.id;
      }
    }

    // Validate entity links in parallel - ensure they belong to this user
    // Skip validation for IDs resolved from appointmentId (already validated above)
    const validations = await Promise.all([
      resolvedConsultationId && !validatedData.appointmentId
        ? prisma.consultation
            .findFirst({
              where: {
                id: resolvedConsultationId,
                requestedBy: { userId: session.user.id },
              },
            })
            .then((c) => ({ type: "consultation", valid: !!c }))
        : Promise.resolve({ type: "consultation", valid: true }),
      resolvedSubscriptionId && !validatedData.appointmentId
        ? prisma.subscription
            .findFirst({
              where: {
                id: resolvedSubscriptionId,
                requestedBy: { userId: session.user.id },
              },
            })
            .then((s) => ({ type: "subscription", valid: !!s }))
        : Promise.resolve({ type: "subscription", valid: true }),
      validatedData.paymentId
        ? prisma.payment
            .findFirst({
              where: {
                id: validatedData.paymentId,
                userId: session.user.id,
              },
            })
            .then((p) => ({ type: "payment", valid: !!p }))
        : Promise.resolve({ type: "payment", valid: true }),
    ]);

    const invalidEntity = validations.find((v) => !v.valid);
    if (invalidEntity) {
      return supportError({
        status: 400,
        code: "INVALID_ID",
        message: `Invalid ${invalidEntity.type} ID`,
        context: {
          route: TICKETS_ROUTE,
          action: "create",
          entity: invalidEntity.type,
        },
      });
    }

    // Dedup: a payment-linked ticket reuses any still-open ticket the user
    // already filed for the same payment (shared factory helper).
    if (validatedData.paymentId) {
      const existing = await findOpenTicketForPayment(
        session.user.id,
        validatedData.paymentId,
      );
      if (existing) {
        return NextResponse.json(existing, { status: 200 });
      }
    }

    // #1021 — stamp the submitter's active org so enterprise tickets can be
    // routed and SLA-tracked per organisation instead of vanishing into the
    // B2C queue. First ACTIVE membership wins (users belong to one org in
    // practice; multi-org members pick their primary dashboard context).
    // Read from verified memberships, never client-asserted.
    const membership = await prisma.membership.findFirst({
      where: { userId: session.user.id, status: "ACTIVE" },
      select: { organizationId: true },
      orderBy: { createdAt: "asc" },
    });

    // The shared factory owns the write: it stamps lastMessageAt at creation
    // and notifies staff without letting a notification failure turn a
    // committed ticket into a 500. It already accepts organizationId, so
    // #1021's attribution rides THROUGH it rather than around it — keeping one
    // writer instead of two that drift.
    const ticket = await createSupportTicket({
      userId: session.user.id,
      title: validatedData.title,
      description: validatedData.description,
      priority: validatedData.priority || "MEDIUM",
      category: validatedData.category,
      issueType: validatedData.issueType,
      organizationId: membership?.organizationId,
      consultationId: resolvedConsultationId,
      subscriptionId: resolvedSubscriptionId,
      paymentId: validatedData.paymentId,
    });

    return NextResponse.json(ticket, { status: 201 });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: TICKETS_ROUTE, action: "create" },
    });
  }
}
