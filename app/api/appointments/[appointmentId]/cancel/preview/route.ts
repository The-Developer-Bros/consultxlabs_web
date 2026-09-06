import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

import { isPrivileged } from "@/lib/auth-helpers";
import { getSession } from "@/lib/auth-server";
import {
  bookingAppointmentFilter,
  resolveBookingRefundContext,
} from "@/lib/booking/cancellation-scope";
import { isOrgAdminOfAppointment } from "@/lib/booking/org-actor";
import { fundingRailForIntent } from "@/lib/payments/operations/booking-refund";
import { quoteBookingRefund } from "@/lib/payments/operations/cancellation-policy";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import prisma from "@/lib/prisma";

/** Every Appointment field the quote reads. */
async function loadPreviewAppointment(appointmentId: string) {
  return prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      organizationId: true,
      consultationId: true,
      subscriptionId: true,
      webinarId: true,
      classId: true,
      consultation: {
        select: {
          requestedById: true,
          requestedBy: { select: { userId: true } },
          consultationPlan: {
            select: {
              consultantProfileId: true,
              consultantProfile: { select: { userId: true } },
            },
          },
        },
      },
      subscription: {
        select: {
          requestedById: true,
          requestedBy: { select: { userId: true } },
          subscriptionPlan: {
            select: {
              consultantProfileId: true,
              consultantProfile: { select: { userId: true } },
            },
          },
        },
      },
      webinar: {
        select: {
          webinarPlan: {
            select: {
              consultantProfileId: true,
              consultantProfile: { select: { userId: true } },
            },
          },
        },
      },
      class: {
        select: {
          classPlan: {
            select: {
              consultantProfileId: true,
              consultantProfile: { select: { userId: true } },
            },
          },
        },
      },
    },
  });
}

type PreviewAppointment = NonNullable<
  Awaited<ReturnType<typeof loadPreviewAppointment>>
>;

type ActorRoles = {
  isParticipant: boolean;
  consultantUserId: string | null;
  consulteeUserId: string | null;
};

/**
 * Who the viewer is on this booking, mirroring the POST route's derivation
 * branch for branch. Note what the group-event branches do NOT say: an attendee
 * is not a participant of a class or webinar here, because the POST route does
 * not treat them as one either. Attendees leave through the roster route, which
 * refunds one seat under the notice tiers; this route quotes the organiser's
 * act, which cancels the whole event.
 */
function deriveActorRoles(
  appointment: PreviewAppointment,
  actor: {
    consultantProfileId?: string | null;
    consulteeProfileId?: string | null;
  },
): ActorRoles {
  const actorConsultantProfileId = actor.consultantProfileId;
  const actorConsulteeProfileId = actor.consulteeProfileId;

  if (appointment.consultation) {
    const plan = appointment.consultation.consultationPlan;
    return {
      consultantUserId: plan?.consultantProfile?.userId ?? null,
      consulteeUserId: appointment.consultation.requestedBy?.userId ?? null,
      isParticipant:
        (!!actorConsultantProfileId &&
          actorConsultantProfileId === plan?.consultantProfileId) ||
        (!!actorConsulteeProfileId &&
          actorConsulteeProfileId === appointment.consultation.requestedById),
    };
  }
  if (appointment.subscription) {
    const plan = appointment.subscription.subscriptionPlan;
    return {
      consultantUserId: plan?.consultantProfile?.userId ?? null,
      consulteeUserId: appointment.subscription.requestedBy?.userId ?? null,
      isParticipant:
        (!!actorConsultantProfileId &&
          actorConsultantProfileId === plan?.consultantProfileId) ||
        (!!actorConsulteeProfileId &&
          actorConsulteeProfileId === appointment.subscription.requestedById),
    };
  }
  if (appointment.webinar) {
    const plan = appointment.webinar.webinarPlan;
    return {
      consultantUserId: plan?.consultantProfile?.userId ?? null,
      consulteeUserId: null,
      isParticipant:
        !!actorConsultantProfileId &&
        actorConsultantProfileId === plan?.consultantProfileId,
    };
  }
  if (appointment.class) {
    const plan = appointment.class.classPlan;
    return {
      consultantUserId: plan?.consultantProfile?.userId ?? null,
      consulteeUserId: null,
      isParticipant:
        !!actorConsultantProfileId &&
        actorConsultantProfileId === plan?.consultantProfileId,
    };
  }
  return {
    isParticipant: false,
    consultantUserId: null,
    consulteeUserId: null,
  };
}

/**
 * What cancelling a class or webinar actually pays back.
 *
 * The POST route does not tier a group event at all: it hands the whole event
 * to `refundWholeEventPayments`, which refunds EVERY attendee's seat in full,
 * whoever pressed cancel. Quoting that act against the viewer's own payment was
 * the defect — an organiser owns no seat, so the preview found no payment and
 * told them "no refund at this notice" while the click was about to return
 * every attendee's money.
 *
 * The payment set is `refundWholeEventPayments`' own, filter for filter,
 * including its absence of a `deletedAt` clause: a quote that reads a different
 * set than the charge is just a second opinion. Each seat is worth its
 * refundable balance rather than its gross, because that is what a full refund
 * of an already partly-refunded seat returns.
 */
async function quoteWholeEventRefund(
  kind: "class" | "webinar",
  eventId: string,
) {
  const seats = await prisma.payment.findMany({
    where: {
      appointment:
        kind === "webinar" ? { webinarId: eventId } : { classId: eventId },
      paymentStatus: "SUCCEEDED",
      amount: { gt: 0 },
    },
    select: { amount: true, currency: true, ...REFUNDABLE_BALANCE_SELECT },
  });

  return {
    estimatedRefundPaise: seats.reduce(
      (total, seat) =>
        total + refundableBalancePaise(Number(seat.amount), seat),
      0,
    ),
    /** Paid seats — the attendees who are owed something, not the roster. */
    attendeeCount: seats.length,
    // Settlement is INR-only by design, so the seats of one event share a
    // currency and the sum above is denominated in it.
    currency: seats[0]?.currency ?? "INR",
  };
}

/**
 * What cancelling a 1:1 booking pays back: a tiered share of the one payment
 * that funds it.
 *
 * Every input is the POST route's own — the same context builder, the same tier
 * function, the same linear proration and the same clamp to the refundable
 * balance — because a quote that restates the rule is a rule that can drift
 * from the charge.
 */
async function quoteIndividualBooking(
  appointment: PreviewAppointment,
  actor: {
    id: string;
    consultantProfileId?: string | null;
  },
  roles: ActorRoles,
  isPrivilegedUser: boolean,
) {
  const bookingRef = {
    appointmentId: appointment.id,
    consultationId: appointment.consultationId,
    subscriptionId: appointment.subscriptionId,
    classId: appointment.classId,
    webinarId: appointment.webinarId,
  };
  const ctx = await resolveBookingRefundContext(bookingRef);

  // The context deliberately ignores zero-amount payments, so a booking paid
  // entirely in referral credits reads as unpaid there. Its `free_` intent is
  // the only signal that value was exchanged at all (#1161).
  const bookingPayment = await prisma.payment.findFirst({
    where: {
      appointment: bookingAppointmentFilter(bookingRef),
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
    },
    orderBy: { createdAt: "asc" },
    select: { currency: true, paymentIntent: true },
  });

  const isConsultantInitiated =
    (!!actor.consultantProfileId && roles.consultantUserId === actor.id) ||
    (isPrivilegedUser && actor.id !== roles.consulteeUserId);

  // #1319 — the notice tier, the proration and the clamp are the POST route's
  // own code now, not a restatement of it. An unpaid booking quotes off zeros,
  // which the clamp turns into zero.
  const quote = quoteBookingRefund({
    policy: ctx.policy,
    hoursUntilNextSession: ctx.hoursUntilNextSession,
    slotsTotal: ctx.slotsTotal,
    sessionsRemaining: ctx.sessionsRemaining,
    isSubscription: !!appointment.subscriptionId,
    isConsultantInitiated,
    // #1500 — a booking funded entirely by referral credit. The rail alone is not
    // enough: `free_` with a non-zero amount is a mixed payment and settles on the
    // money arm, so both halves of the predicate are load-bearing.
    isFreeCreditFunded:
      fundingRailForIntent(bookingPayment?.paymentIntent) === "CREDITS" &&
      (ctx.paidPayment?.amountPaise ?? 0) === 0,
    grossPaise: ctx.paidPayment?.amountPaise ?? 0,
    refundablePaise: ctx.paidPayment?.refundablePaise ?? 0,
  });

  return {
    refundPct: quote.refundPct,
    estimatedRefundPaise: quote.refundPaise,
    // #1500 — the dialog must say "your credit comes back in full" rather than show
    // a ₹0 refund next to a 100% tier, which is what a credit-funded quote looks
    // like when only the money fields are read.
    creditRestoresInFull: quote.creditRestoresInFull,
    currency: bookingPayment?.currency ?? "INR",
    hoursUntilNextSession: ctx.hoursUntilNextSession,
    // Only true when proration actually moves the number — an untouched
    // subscription refunds off the whole price, like every other booking.
    // Keyed on the same two numbers the base is: any session that is no
    // longer live has already shrunk the quote, whether or not it COMPLETED.
    prorated: quote.prorated,
    // Which rail the money comes back on, which is the sentence the dialog
    // actually needs. `free_` alone was not enough: a wallet-, invoice- or
    // licence-funded learner was told their card would be credited in 5–7
    // working days for a card that was never charged, and the org whose
    // balance was actually restored was not mentioned at all.
    fundingRail: fundingRailForIntent(bookingPayment?.paymentIntent),
    wholeEvent: false,
    attendeeCount: null,
  };
}

/**
 * What cancelling this booking right now would pay back — computed, never
 * written.
 *
 * The confirmation dialog said "any refund follows the booking's cancellation
 * policy", which is true and useless: the number is knowable before the click,
 * and someone deciding whether to cancel is deciding about that number.
 *
 * Every input is the sibling POST route's own: the same context builder, the
 * same tier function, the same linear proration and the same clamp to the
 * refundable balance. Restating any of that here would let the quote and the
 * charge drift.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { appointmentId } = await params;

    const appointment = await loadPreviewAppointment(appointmentId);

    if (!appointment) {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    // Authorization mirrors the POST route exactly. A preview that answers
    // where the cancel would 403 is a quote for an action the viewer cannot
    // take — worse than no quote. Trials are absent from both for the same
    // reason: the POST route has no trial branch, so they fall through to the
    // privileged/org-admin checks here too.
    const roles = deriveActorRoles(appointment, session.user);

    const isPrivilegedUser = isPrivileged(session.user.role);
    const isOrgAdminActor =
      !roles.isParticipant &&
      !isPrivilegedUser &&
      (await isOrgAdminOfAppointment(
        session.user.id,
        appointment.organizationId,
      ));

    if (!roles.isParticipant && !isPrivilegedUser && !isOrgAdminActor) {
      return NextResponse.json(
        { error: "You are not authorized to cancel this appointment" },
        { status: 403 },
      );
    }

    // Group events never reach the notice tiers or the viewer's own payment:
    // the POST route refunds the entire roster in full. Quote that instead.
    let eventKind: "class" | "webinar" | null = null;
    let eventId: string | null = null;
    if (appointment.webinarId) {
      eventKind = "webinar";
      eventId = appointment.webinarId;
    } else if (appointment.classId) {
      eventKind = "class";
      eventId = appointment.classId;
    }

    if (eventKind && eventId) {
      const quote = await quoteWholeEventRefund(eventKind, eventId);
      return NextResponse.json({
        refundPct: 100,
        estimatedRefundPaise: quote.estimatedRefundPaise,
        currency: quote.currency,
        // The whole-event rail never consults the clock, so no notice window is
        // computed for it.
        hoursUntilNextSession: null,
        prorated: false,
        // Seats fund through several rails at once (card, org wallet, credits),
        // so no single funding sentence is true of the aggregate. Null rather
        // than a rail: the whole-event copy stands on its own and naming one
        // rail here would be a claim about seats it does not cover.
        fundingRail: null,
        wholeEvent: true,
        attendeeCount: quote.attendeeCount,
      });
    }

    return NextResponse.json(
      await quoteIndividualBooking(
        appointment,
        session.user,
        roles,
        isPrivilegedUser,
      ),
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    return NextResponse.json(
      { error: "Could not estimate the refund" },
      { status: 500 },
    );
  }
}
