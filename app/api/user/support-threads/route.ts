/**
 * #support-hub — the signed-in user's per-appointment support threads, for the
 * Support hub's "Sessions" subtab. List shape (thread + appointment summary +
 * last-message preview), NOT transcripts — the conversation itself loads via
 * /api/appointments/[appointmentId]/support when a row is opened. Sorted by
 * last activity (lastMessageAt, nulls last → createdAt), newest first.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth-server";
import { supportError } from "@/lib/api/support-http";
import prisma from "@/lib/prisma";

const USER_THREADS_ROUTE = "user.support-threads";

const querySchema = z.object({
  /** Cap the list; the hub buckets client-side. */
  take: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return supportError({ status: 401, code: "UNAUTHORIZED" });
    }
    const parsed = querySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams),
    );
    const take = parsed.success ? parsed.data.take : 50;

    const threads = await prisma.appointmentSupportThread.findMany({
      where: { userId: session.user.id },
      orderBy: [
        { lastMessageAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
      ],
      take,
      select: {
        id: true,
        appointmentId: true,
        category: true,
        status: true,
        activeChannel: true,
        lastMessageAt: true,
        createdAt: true,
        resolvedAt: true,
        supportTicketId: true,
        // Last-message preview for the list row — one message, no more.
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { sender: true, body: true, createdAt: true },
        },
        appointment: {
          select: {
            appointmentType: true,
            slotsOfAppointment: {
              orderBy: { startsAt: "asc" },
              take: 1,
              select: { startsAt: true, endsAt: true },
            },
            // Org tag so the hub can label org-hosted sessions AND withhold
            // the "Go to appointment" link (no detail page exists for them).
            organization: { select: { id: true, name: true } },
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

    const data = threads.map((t) => ({
      id: t.id,
      appointmentId: t.appointmentId,
      category: t.category,
      status: t.status,
      activeChannel: t.activeChannel,
      lastMessageAt: t.lastMessageAt ?? t.createdAt,
      createdAt: t.createdAt,
      resolvedAt: t.resolvedAt,
      supportTicketId: t.supportTicketId,
      lastMessage: t.messages[0]
        ? { sender: t.messages[0].sender, body: t.messages[0].body }
        : null,
      appointment: {
        appointmentType: t.appointment.appointmentType,
        startsAt: t.appointment.slotsOfAppointment[0]?.startsAt ?? null,
        organizationName: t.appointment.organization?.name ?? null,
        planTitle:
          t.appointment.consultation?.consultationPlan?.title ??
          t.appointment.subscription?.subscriptionPlan?.title ??
          t.appointment.webinar?.webinarPlan?.title ??
          t.appointment.class?.classPlan?.title ??
          null,
      },
    }));

    return NextResponse.json({ data });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: USER_THREADS_ROUTE, action: "list" },
    });
  }
}
