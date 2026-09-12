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
import { groupSlotsIntoRuns } from "@/lib/appointments/slots";
import { AppointmentIdParams } from "@/schemas/support";
import { parseRouteParams, supportError } from "@/lib/api/support-http";
import {
  authorizeAppointment,
  appointmentAuthzError,
} from "@/lib/api/appointment-access";

const FEEDBACK_ROUTE = "appointments.feedback";

/** How much of the booking the GET answers for. Parsed rather than compared: an
 *  unrecognised value used to fall through to the single-appointment answer, so a
 *  typo'd or renamed scope returned a NARROWER result than the caller asked for and
 *  said 200 about it. */
const scopeSchema = z.enum(["appointment", "booking"]).default("appointment");

const feedbackSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).optional(),
  /** Which call of this booking is being rated. */
  slotId: z.string().min(1).max(64),
});

export async function GET(
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
    // #705 — the CONSULTANT sees the individual ratings their calls received.
    // A deliberate product call: at this volume an aggregate over two ratings
    // tells nobody anything, so the detail is what makes it actionable. The
    // copy the rater sees says so plainly — nothing here is promised private.
    // On a 1:1 booking this identifies the rater, which is exactly why
    // SessionRatingRow states it on the control itself rather than leaving it
    // quietly enabled.
    const asProvider =
      appointmentRaterRole(auth.userId, auth.detail) === "PROVIDER";

    // #1540 — one request for the whole BOOKING, not one per child appointment.
    //
    // The timeline renders every session of a booking, and a subscription's
    // sessions each carry their own child appointment id — up to 25 of them. The
    // hook fanned out one request per id, each re-authorizing and re-reading the
    // appointment graph, so rendering one page cost roughly a hundred Prisma
    // operations. Under `PG_POOL_MAX=1` on Netlify every one of those serialises,
    // so the parallelism the client appeared to buy did not exist at the database.
    //
    // `authorizeAppointment` already loaded the siblings to decide the answer, so
    // widening the scope costs NO extra query — the ids are in hand.
    const scope = scopeSchema.safeParse(
      new URL(req.url).searchParams.get("scope") ?? undefined,
    );
    if (!scope.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: scope.error.flatten(),
        context: { route: FEEDBACK_ROUTE, action: "get", appointmentId },
      });
    }
    const scopeIds =
      scope.data === "booking"
        ? [auth.detail.appointment.id, ...auth.detail.siblings.map((s) => s.id)]
        : [appointmentId];

    // Which calls of this booking the caller may rate at all, so the timeline
    // offers stars only where a rating would be accepted rather than erroring
    // after the click.
    const rateable = asProvider
      ? []
      : await prisma.slotOfAppointment.findMany({
          where: { appointmentId: { in: scopeIds }, ...heldSlot(auth.userId) },
          select: { id: true },
        });

    // Every call of this booking the caller has rated (or, for the provider,
    // every attendee rating on it), so the timeline can show a per-session
    // breakdown instead of one number for the package.
    const feedback = await prisma.appointmentFeedback.findMany({
      where: asProvider
        ? { appointmentId: { in: scopeIds }, raterRole: "CONSULTEE" }
        : { appointmentId: { in: scopeIds }, userId: auth.userId },
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

    // Normalise to the run's ANCHOR — the rating belongs to the MEETING, and a
    // meeting longer than 30 minutes is stored as several rows (#1061). The
    // anchor is already "the only row the video room may ever be keyed to", so
    // this is the identity the codebase uses for a session; MeetingSession
    // hangs off exactly this row, which is why the video path happened to be
    // safe. The offline path was not: an UNVERIFIED run has no MeetingSession,
    // so every row in it satisfies `heldSlot` independently and one 90-minute
    // in-person session could take three separate ratings. Resolving here
    // makes one-rating-per-meeting a rule rather than a UI convention.
    const runRows = await prisma.slotOfAppointment.findMany({
      where: { appointmentId, deletedAt: null },
      select: {
        id: true,
        appointmentId: true,
        startsAt: true,
        endsAt: true,
        isTentative: true,
        completionStatus: true,
      },
    });
    const ratedSlotId =
      groupSlotsIntoRuns(runRows).find((run) =>
        run.slots.some((row) => row.id === slot.id),
      )?.anchor.id ?? slot.id;

    // `updatedAt` is stamped HERE, not by `@updatedAt`. Prisma populates that
    // attribute on create as well as on update, so the column could never be NULL
    // — and NULL is the meaning the schema documents: never edited since it was
    // written. Only a changed OPINION counts, the same rule the review upsert
    // applies to `editedAt`: re-submitting identical stars is idempotent and must
    // not read to a moderator as somebody who keeps changing their mind.
    const previous = await prisma.appointmentFeedback.findUnique({
      where: {
        slotOfAppointmentId_userId: {
          slotOfAppointmentId: ratedSlotId,
          userId: auth.userId,
        },
      },
      select: { rating: true, comment: true },
    });
    const opinionChanged =
      previous !== null &&
      (previous.rating !== body.data.rating ||
        // An absent `comment` is "not supplied", which the upsert already treats
        // as leaving the stored note alone — so it is not an edit either.
        (body.data.comment !== undefined &&
          (previous.comment ?? "") !== body.data.comment));

    const feedback = await prisma.appointmentFeedback.upsert({
      where: {
        slotOfAppointmentId_userId: {
          slotOfAppointmentId: ratedSlotId,
          userId: auth.userId,
        },
      },
      create: {
        slotOfAppointmentId: ratedSlotId,
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
        ...(opinionChanged ? { updatedAt: new Date() } : {}),
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
