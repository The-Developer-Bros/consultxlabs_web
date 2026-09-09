/**
 * #appt-support — private per-participant CSAT for ONE VIDEO CALL (1–5 + note),
 * distinct from the public ConsultantReview. Upsert, so re-submitting edits.
 *
 * Per call, not per appointment: an appointment is not a session. A subscription
 * booking holds up to 24 of them, so one rating per appointment meant a single
 * score for a three-month package, arriving months after the sessions it
 * described. GET returns every call of this booking the caller has rated.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { appointmentRaterRole } from "@/lib/data/appointment-detail";
import { heldSlot } from "@/lib/reviews";
import { AppointmentIdParams } from "@/schemas/support";
import { parseRouteParams, supportError } from "@/lib/api/support-http";
import {
  authorizeAppointment,
  appointmentAuthzError,
} from "@/lib/api/appointment-access";

const FEEDBACK_ROUTE = "appointments.feedback";

const feedbackSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).optional(),
  /** Which call of this booking is being rated. */
  slotId: z.string().min(1).max(64),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const id = await parseRouteParams(AppointmentIdParams, params, {
    route: FEEDBACK_ROUTE,
  });
  if (!id.ok) return id.response;
  const { appointmentId } = id.data;
  try {
    const auth = await authorizeAppointment(appointmentId);
    if ("code" in auth) {
      return appointmentAuthzError(auth, {
        route: FEEDBACK_ROUTE,
        appointmentId,
      });
    }
    // #705 — the CONSULTANT sees the individual ratings their calls received.
    // A deliberate product call: at this volume an aggregate over two ratings
    // tells nobody anything, so the detail is what makes it actionable. The
    // copy the rater sees says so plainly — nothing here is promised private.
    // On a 1:1 booking this identifies the rater, which is exactly why
    // SessionRatingRow states it on the control itself rather than leaving it
    // quietly enabled.
    const asProvider =
      appointmentRaterRole(auth.userId, auth.detail) === "PROVIDER";

    // Which calls of this booking the caller may rate at all, so the timeline
    // offers stars only where a rating would be accepted rather than erroring
    // after the click.
    const rateable = asProvider
      ? []
      : await prisma.slotOfAppointment.findMany({
          where: { appointmentId, ...heldSlot(auth.userId) },
          select: { id: true },
        });

    // Every call of this booking the caller has rated (or, for the provider,
    // every attendee rating on it), so the timeline can show a per-session
    // breakdown instead of one number for the package.
    const feedback = await prisma.appointmentFeedback.findMany({
      where: asProvider
        ? { appointmentId, raterRole: "CONSULTEE" }
        : { appointmentId, userId: auth.userId },
      select: {
        id: true,
        slotOfAppointmentId: true,
        rating: true,
        // The SCORE is disclosed to the provider; the free-text note is not.
        // Every comment in this table was typed into AppointmentCsatCard, whose
        // own header called it "private per-participant CSAT" — and the row that
        // replaced it takes stars only, so it cannot re-ask for consent that was
        // never given. Nothing renders this field for a provider today, so
        // withholding it costs no feature.
        comment: !asProvider,
        createdAt: true,
      },
      // A provider could otherwise infer a rater from ordering on a group call.
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({
      data: feedback,
      rateableSlotIds: rateable.map((s) => s.id),
    });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: FEEDBACK_ROUTE, action: "get", appointmentId },
    });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const id = await parseRouteParams(AppointmentIdParams, params, {
    route: FEEDBACK_ROUTE,
  });
  if (!id.ok) return id.response;
  const { appointmentId } = id.data;
  try {
    const auth = await authorizeAppointment(appointmentId);
    if ("code" in auth) {
      return appointmentAuthzError(auth, {
        route: FEEDBACK_ROUTE,
        appointmentId,
      });
    }
    // CSAT is a PARTICIPANT's private rating: staff/admin read access must
    // not become write access — a privileged non-participant's row would
    // pollute the org quality aggregate with a rating they never earned.
    // #705 — and WHICH side they are on. A consultant rating their own session
    // used to be indistinguishable from an attendee's rating and landed in the
    // org quality average; the aggregate now filters on CONSULTEE, so an
    // unattributable row fails closed instead of counting.
    const raterRole = appointmentRaterRole(auth.userId, auth.detail);
    if (!raterRole) {
      return supportError({
        status: 403,
        code: "FORBIDDEN",
        context: { route: FEEDBACK_ROUTE, appointmentId },
      });
    }

    const body = feedbackSchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: body.error.flatten(),
        context: { route: FEEDBACK_ROUTE, appointmentId },
      });
    }

    // The slot must belong to THIS appointment: without the check a caller
    // could rate a call from a booking they merely have access to the id of.
    const slot = await prisma.slotOfAppointment.findFirst({
      where: {
        id: body.data.slotId,
        appointmentId,
        // You may rate a call you ATTENDED, or one nobody could have recorded
        // (an offline session). A COMPLETED slot the caller never joined does
        // not qualify: a no-show rating would otherwise feed the consultant's
        // quality signal. `heldSlot` also excludes cancelled and rescheduled
        // calls, which never happened at all.
        ...heldSlot(auth.userId),
      },
      select: { id: true },
    });
    if (!slot) {
      return supportError({
        status: 404,
        code: "NOT_FOUND",
        message:
          "That session isn't part of this booking, or it didn't take place",
        context: { route: FEEDBACK_ROUTE, action: "save", appointmentId },
      });
    }

    const feedback = await prisma.appointmentFeedback.upsert({
      where: {
        slotOfAppointmentId_userId: {
          slotOfAppointmentId: slot.id,
          userId: auth.userId,
        },
      },
      create: {
        slotOfAppointmentId: slot.id,
        appointmentId,
        userId: auth.userId,
        organizationId: auth.organizationId,
        rating: body.data.rating,
        comment: body.data.comment,
        raterRole,
      },
      update: {
        rating: body.data.rating,
        comment: body.data.comment,
        raterRole,
      },
    });
    return NextResponse.json({ data: feedback });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: FEEDBACK_ROUTE, action: "save", appointmentId },
    });
  }
}
