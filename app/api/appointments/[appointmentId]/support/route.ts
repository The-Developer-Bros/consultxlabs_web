/**
 * #appt-support — per-appointment support thread. GET loads this user's thread +
 * messages; POST advances it one turn through the active resolver. Authz is the
 * same participation check the appointment-detail route uses (capability, not
 * UserRole), plus platform ADMIN/STAFF, plus (#support-hub) the org-party
 * branch: an org OPERATOR may open their OWN conversation on their org's
 * appointment, restricted to the org-party intents — never anyone else's
 * transcript (ADR 20).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { runSupportTurn, ORG_PARTY_CATEGORIES } from "@/lib/support/service";
import { buildSupportContext } from "@/lib/support/context";
import { flowsForContext } from "@/lib/support/flows";
import { MESSAGE_ORDER } from "@/lib/support/message-seq";
import { AppointmentIdParams } from "@/schemas/support";
import { SupportThreadCategoryEnum } from "@/schemas/enums";
import { parseRouteParams, supportError } from "@/lib/api/support-http";
import {
  authorizeAppointment,
  appointmentAuthzError,
} from "@/lib/api/appointment-access";

const SUPPORT_ROUTE = "appointments.support";

const CATEGORY = SupportThreadCategoryEnum;

const turnSchema = z
  .object({
    category: CATEGORY.optional(),
    chosenOptionId: z.string().max(200).optional(),
    userMessage: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.category || v.chosenOptionId || v.userMessage, {
    message: "A turn needs a category, a chosen option, or a message",
  });

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const id = await parseRouteParams(AppointmentIdParams, params, {
    route: SUPPORT_ROUTE,
  });
  if (!id.ok) return id.response;
  const { appointmentId } = id.data;
  try {
    // orgParty: true — an operator may open their OWN thread (ADR 20).
    const auth = await authorizeAppointment(appointmentId, true);
    if ("code" in auth)
      return appointmentAuthzError(auth, {
        route: SUPPORT_ROUTE,
        appointmentId,
      });

    const thread = await prisma.appointmentSupportThread.findUnique({
      where: { appointmentId_userId: { appointmentId, userId: auth.userId } },
      include: {
        messages: { orderBy: MESSAGE_ORDER },
        // #705 — an escalated thread is ASYNCHRONOUS: nobody is composing a
        // reply, and a typing indicator promised otherwise. The drawer shows
        // this deadline instead, which we already committed to at intake.
        supportTicket: { select: { referenceNumber: true, ackDueAt: true } },
      },
    });

    // #support-hub — the intents the SERVER offers for this appointment
    // (stage/provider/org gating is server truth; the sheet renders exactly
    // this list instead of a hardcoded menu).
    let intents: { category: string; title: string }[] = [];
    try {
      // Deliberately UNSCOPED: this context decides which intents to OFFER,
      // so it must describe the current-or-next session. Scoping it to the
      // thread's stored category would let a resolved no-show thread keep
      // gating the menu on a session that finished weeks ago.
      const ctx = await buildSupportContext(
        thread?.id ?? "unstarted",
        appointmentId,
        auth.userId,
      );
      if (ctx) {
        intents = flowsForContext(ctx).map((f) => ({
          category: f.category,
          title: f.title,
        }));
      }
    } catch (cause) {
      // Intent resolution is an optimization — the sheet falls back to its
      // static list and the POST path still gates authoritatively. But a
      // persistent regression here would be invisible, so record it.
      Sentry.captureException(cause, {
        tags: { subsystem: "support", code: "INTENTS_DEGRADED" },
        extra: { route: SUPPORT_ROUTE, appointmentId },
        level: "warning",
      });
    }

    return NextResponse.json({ data: thread, intents });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "appointments.support", action: "get", appointmentId },
    });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const id = await parseRouteParams(AppointmentIdParams, params, {
    route: SUPPORT_ROUTE,
  });
  if (!id.ok) return id.response;
  const { appointmentId } = id.data;
  try {
    // orgParty: true — an operator may open their OWN thread (ADR 20).
    const auth = await authorizeAppointment(appointmentId, true);
    if ("code" in auth)
      return appointmentAuthzError(auth, {
        route: SUPPORT_ROUTE,
        appointmentId,
      });

    const body = turnSchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: body.error.flatten(),
        context: {
          route: "appointments.support",
          action: "turn",
          appointmentId,
        },
      });
    }
    // Org parties raise only the org-party intents on someone else's session.
    if (
      auth.isOrgParty &&
      body.data.category &&
      !ORG_PARTY_CATEGORIES.has(body.data.category)
    ) {
      return supportError({
        status: 403,
        code: "FORBIDDEN",
        context: {
          route: "appointments.support",
          action: "turn",
          appointmentId,
          attemptedCategory: body.data.category,
        },
      });
    }

    const result = await runSupportTurn(appointmentId, auth.userId, {
      ...body.data,
      isOrgParty: auth.isOrgParty,
    });
    if (!result) {
      return supportError({
        status: 404,
        code: "NOT_FOUND",
        context: {
          route: "appointments.support",
          action: "turn",
          appointmentId,
        },
      });
    }
    return NextResponse.json({ data: result });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "appointments.support", action: "turn", appointmentId },
    });
  }
}
