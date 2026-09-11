/**
 * #support-hub — Staff/Admin view of ONE per-appointment support thread.
 *
 * GET   → full transcript + requester + appointment summary + linked ticket.
 * POST  → agent reply. The message lands on the thread as AGENT (what the user
 *         sees in their conversation) AND is mirrored as a public
 *         SupportResponse on the linked ticket (so the ops queue's history and
 *         the user's "My requests" view stay complete). One notification, not
 *         two. CAS: OPEN→IN_PROGRESS on the ticket, thread stays ESCALATED.
 * PATCH → status change (RESOLVED / CLOSED / IN_PROGRESS), CAS-guarded,
 *         mirrored to the linked ticket when present.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import {
  notifySupportTicketResponse,
  notifySupportTicketUpdate,
} from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { SupportThreadIdParams } from "@/schemas/support";
import { parseRouteParams, supportError } from "@/lib/api/support-http";
import { MESSAGE_ORDER, allocateMessageSeq } from "@/lib/support/message-seq";
import { applyStaffReply } from "@/lib/support/sla";

const THREAD_ROUTE = "staff.support-thread";

interface RouteParams {
  params: Promise<{ threadId: string }>;
}

const replySchema = z.object({
  message: z.string().trim().min(1).max(4000),
});

const patchSchema = z.object({
  status: z.enum(["IN_PROGRESS", "RESOLVED", "CLOSED"]),
});

async function loadThread(threadId: string) {
  return prisma.appointmentSupportThread.findUnique({
    where: { id: threadId },
    include: {
      user: { select: { id: true, name: true, email: true, image: true } },
      messages: { orderBy: MESSAGE_ORDER },
      supportTicket: { select: { id: true, title: true, status: true } },
      appointment: {
        select: {
          id: true,
          appointmentType: true,
          slotsOfAppointment: {
            orderBy: { startsAt: "asc" },
            take: 1,
            select: { startsAt: true, endsAt: true },
          },
          consultation: {
            select: { consultationPlan: { select: { title: true } } },
          },
          subscription: {
            select: { subscriptionPlan: { select: { title: true } } },
          },
          webinar: { select: { webinarPlan: { select: { title: true } } } },
          class: { select: { classPlan: { select: { title: true } } } },
        },
      },
    },
  });
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const id = await parseRouteParams(SupportThreadIdParams, params, {
    route: THREAD_ROUTE,
  });
  if (!id.ok) return id.response;
  const { threadId } = id.data;
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const thread = await loadThread(threadId);
    if (!thread) {
      return supportError({
        status: 404,
        code: "NOT_FOUND",
        message: "Thread not found",
        context: { route: THREAD_ROUTE, action: "get", threadId },
      });
    }
    return NextResponse.json({ data: thread });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: THREAD_ROUTE, action: "get", threadId },
    });
  }
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const id = await parseRouteParams(SupportThreadIdParams, params, {
    route: THREAD_ROUTE,
  });
  if (!id.ok) return id.response;
  const { threadId } = id.data;
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

    const parsed = replySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: parsed.error.flatten(),
        context: { route: THREAD_ROUTE, action: "reply", threadId },
      });
    }
    const { message } = parsed.data;

    const thread = await prisma.appointmentSupportThread.findUnique({
      where: { id: threadId },
      include: {
        supportTicket: {
          select: {
            id: true,
            title: true,
            status: true,
            assignedToId: true,
            // #705 — the SLA clock needs to know whether this is the FIRST
            // human reply, and whether the ticket was already acknowledged.
            acknowledgedAt: true,
            firstAgentReplyAt: true,
          },
        },
      },
    });
    if (!thread) {
      return supportError({
        status: 404,
        code: "NOT_FOUND",
        message: "Thread not found",
        context: { route: THREAD_ROUTE, action: "reply", threadId },
      });
    }

    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      // The user-facing message on the thread…
      const seq = await allocateMessageSeq(tx, thread.id, 1);
      const agentMessage = await tx.supportMessage.create({
        data: {
          threadId: thread.id,
          sender: "AGENT",
          body: message,
          seq: seq + 1,
          // #705 — an AGENT row used to record no author, so an escalated
          // transcript could not say which staff member had replied.
          authorUserId: session.user.id,
        },
      });
      await tx.appointmentSupportThread.update({
        where: { id: thread.id },
        data: { lastMessageAt: now },
      });

      // …mirrored as a public response on the linked ticket (if any), so the
      // queue's history and the user's requests view stay one story.
      if (thread.supportTicketId) {
        await tx.supportResponse.create({
          data: {
            message,
            isInternal: false,
            supportTicketId: thread.supportTicketId,
            userId: session.user.id,
          },
        });
        await tx.supportTicket.updateMany({
          // CAS: a concurrent staff move off OPEN must not be clobbered.
          where: { id: thread.supportTicketId, status: "OPEN" },
          data: {
            status: "IN_PROGRESS",
            assignedToId: thread.supportTicket?.assignedToId ?? session.user.id,
            lastMessageAt: now,
          },
        });
        // #705 — the ball is now in the user's court, so the resolution clock
        // stops. Unconditional (not part of the OPEN CAS above): a reply on an
        // already-IN_PROGRESS ticket still pauses the clock and still counts as
        // an acknowledgement.
        await applyStaffReply(tx, thread.supportTicketId, now);
        await tx.supportTicket.update({
          where: { id: thread.supportTicketId },
          data: { lastMessageAt: now },
        });
      }
      return agentMessage;
    });

    if (thread.supportTicketId) {
      void notifySupportTicketResponse(thread.userId, {
        ticketId: thread.supportTicketId,
        ticketTitle: thread.supportTicket?.title ?? "Support",
        message,
        respondedBy: session.user.name ?? "Support",
        // Org-hosted threads land on the org appointments surface; B2C stays a
        // bare /dashboard and the capability router picks the viewer's tree
        // (resolve-href doctrine — never guess the personal route).
        dashboardUrl: notificationHref(thread.organizationId, "appointments"),
        // ADR 23 — inherit the thread's org-ness (attribution only).
        ...notificationScope(thread.organizationId),
      });
    }

    return NextResponse.json({ data: result }, { status: 201 });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: THREAD_ROUTE, action: "reply", threadId },
    });
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const id = await parseRouteParams(SupportThreadIdParams, params, {
    route: THREAD_ROUTE,
  });
  if (!id.ok) return id.response;
  const { threadId } = id.data;
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: parsed.error.flatten(),
        context: { route: THREAD_ROUTE, action: "status", threadId },
      });
    }
    const { status } = parsed.data;

    const thread = await prisma.appointmentSupportThread.findUnique({
      where: { id: threadId },
      select: {
        id: true,
        supportTicketId: true,
        status: true,
        // #705 — needed to tell the USER their thread moved. This route
        // resolved and closed threads and notified nobody.
        userId: true,
        organizationId: true,
        supportTicket: { select: { title: true, referenceNumber: true } },
      },
    });
    if (!thread) {
      return supportError({
        status: 404,
        code: "NOT_FOUND",
        message: "Thread not found",
        context: { route: THREAD_ROUTE, action: "status", threadId },
      });
    }

    const now = new Date();
    // One transaction: the queue and the thread must move together, or the
    // header's "never disagrees" promise is a lie on a partial failure.
    const updatedCount = await prisma.$transaction(async (tx) => {
      // CAS on the thread's own status: the WHERE clause is the transition rule.
      const updated = await tx.appointmentSupportThread.updateMany({
        where: { id: thread.id, status: { notIn: ["CLOSED"] } },
        data: {
          status,
          // RESOLVED stamps the resolution clock; a re-open clears it; CLOSED
          // keeps whatever it had (closing a resolved thread must not erase
          // its resolution time).
          ...(status === "RESOLVED" ? { resolvedAt: now } : {}),
          ...(status === "IN_PROGRESS" ? { resolvedAt: null } : {}),
        },
      });
      if (updated.count === 0) return 0;

      // Mirror to the linked ticket so the queue never disagrees with the thread.
      // A CLOSED ticket cannot follow, and letting the thread move anyway is
      // exactly the disagreement this mirror exists to prevent — so the whole
      // transaction fails instead, and the caller gets a 409 rather than a
      // silent split. Moving to CLOSED is exempt: a closed ticket is already
      // where the thread is going.
      if (thread.supportTicketId) {
        const linked = await tx.supportTicket.findUnique({
          where: { id: thread.supportTicketId },
          select: { status: true },
        });
        if (linked?.status === "CLOSED" && status !== "CLOSED") return 0;
        await tx.supportTicket.updateMany({
          where: { id: thread.supportTicketId, status: { notIn: ["CLOSED"] } },
          data: {
            status,
            lastMessageAt: now,
            // #705 — stop the SLA clock with the status. Without these the
            // breach sweep keeps counting a ticket that ops has finished.
            ...(status === "RESOLVED" ? { resolvedAt: now } : {}),
            ...(status === "CLOSED" ? { closedAt: now } : {}),
            ...(status === "IN_PROGRESS" ? { resolvedAt: null } : {}),
          },
        });
      }
      return updated.count;
    });
    if (updatedCount === 0) {
      return supportError({
        status: 409,
        code: "CONFLICT",
        message:
          "This conversation can no longer change status — it, or the ticket behind it, is already closed",
        context: {
          route: THREAD_ROUTE,
          action: "status",
          threadId,
          attemptedStatus: status,
        },
      });
    }

    // #705 — the user is the only party who cannot see the ops queue, and this
    // route was the one status change nobody told them about.
    if (thread.supportTicketId) {
      void notifySupportTicketUpdate(thread.userId, {
        ticketId: thread.supportTicketId,
        ticketTitle: thread.supportTicket?.referenceNumber
          ? `${thread.supportTicket.referenceNumber} — ${thread.supportTicket.title}`
          : (thread.supportTicket?.title ?? "Support"),
        status,
        dashboardUrl: notificationHref(thread.organizationId, "appointments"),
        ...notificationScope(thread.organizationId),
      });
    }

    return NextResponse.json({ data: { id: thread.id, status } });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: THREAD_ROUTE, action: "status", threadId },
    });
  }
}
