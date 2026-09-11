/**
 * Data layer for /dashboard/organization/[orgId]/compensation (EXPERT per-org
 * view). Server-only reads extracted out of the RSC page (repo convention:
 * lib/data/* for RSC read-fetchers) so the page is a thin renderer and the
 * queries are reusable + testable. #754 / #777 §D.
 *
 * Earnings are read fresh per request — money state is never cached (v2
 * money-safety rule).
 */
import prisma from "@/lib/prisma";
import { toPlain } from "@/lib/data/serialize";
import type { PayoutRecipient } from "@prisma/client";

// #1270 — the shared HOST window (15 min), not the learner's 10. This surface
// is the expert's own per-org view and used to hold a local 10-minute copy, so
// the consultant saw Join appear five minutes later here than on the dashboard
// the page links them to.
import { CONSULTANT_JOIN_WINDOW_MS } from "@/lib/appointments/slots";

export async function getMyArrangementData(params: {
  orgId: string;
  payoutRecipient: PayoutRecipient;
  consultantProfileId: string | null;
}) {
  const { orgId, payoutRecipient, consultantProfileId } = params;
  const now = new Date();
  const nowMs = now.getTime();

  // Active org-default RateCard (catch-all: no contract / plan-type filter).
  const orgDefaultCard = await prisma.rateCard.findFirst({
    where: {
      ownerOrgId: orgId,
      planType: null,
      planId: null,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });

  const payoutAccount =
    payoutRecipient === "ORGANIZATION"
      ? await prisma.organizationPayoutAccount.findUnique({
          where: { organizationId: orgId },
          select: { bankName: true, accountNumberLast4: true, status: true },
        })
      : null;

  // Recent earnings for this consultant on this org's hosted payments. The org
  // link lives on OrganizationEarnings; join via paymentId to ConsultantEarnings.
  const orgEarningPaymentIds = consultantProfileId
    ? (
        await prisma.organizationEarnings.findMany({
          where: { organizationId: orgId },
          select: { paymentId: true },
          orderBy: { createdAt: "desc" },
          take: 20,
        })
      ).map((r) => r.paymentId)
    : [];

  const earnings =
    orgEarningPaymentIds.length > 0
      ? await prisma.consultantEarnings.findMany({
          where: {
            consultantProfileId: consultantProfileId!,
            paymentId: { in: orgEarningPaymentIds },
          },
          orderBy: { id: "desc" },
          take: 20,
          include: {
            payment: {
              select: {
                id: true,
                createdAt: true,
                currency: true,
                appointment: {
                  select: {
                    id: true,
                    appointmentType: true,
                    // Sponsorship marker — distinguishes org-sponsored
                    // bookings from direct/personal panel earnings in the
                    // Recent panel earnings table.
                    organizationId: true,
                  },
                },
              },
            },
          },
        })
      : [];

  // #754 — upcoming sessions this expert hosts VIA this org. Appointment is
  // polymorphic, so we match the plan's consultantProfileId on whichever
  // sub-relation applies. Earnings map onto sessions via the shared appointmentId.
  const earningsByAppointmentId = new Map(
    earnings
      .filter((e) => e.payment.appointment?.id)
      .map((e) => [e.payment.appointment!.id, e]),
  );

  const hostedSessions = consultantProfileId
    ? await prisma.appointment.findMany({
        where: {
          organizationId: orgId,
          slotsOfAppointment: { some: { endsAt: { gte: now } } },
          OR: [
            {
              consultation: {
                consultationPlan: { consultantProfileId },
              },
            },
            {
              subscription: {
                subscriptionPlan: { consultantProfileId },
              },
            },
            { webinar: { webinarPlan: { consultantProfileId } } },
            { class: { classPlan: { consultantProfileId } } },
            { trialSession: { consultantProfileId } },
          ],
        },
        select: {
          id: true,
          appointmentType: true,
          slotsOfAppointment: {
            where: { endsAt: { gte: now } },
            orderBy: { startsAt: "asc" },
            take: 1,
            select: {
              startsAt: true,
              endsAt: true,
              isTentative: true,
              completionStatus: true,
            },
          },
          consultation: {
            select: {
              cancelledAt: true,
              requestedBy: { select: { user: { select: { name: true } } } },
            },
          },
          subscription: {
            select: {
              requestedBy: { select: { user: { select: { name: true } } } },
            },
          },
          trialSession: {
            select: {
              consulteeProfile: {
                select: { user: { select: { name: true } } },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      })
    : [];

  const upcomingSessions = hostedSessions
    .filter(
      (a) => a.slotsOfAppointment.length > 0 && !a.consultation?.cancelledAt,
    )
    .map((a) => {
      const slot = a.slotsOfAppointment[0];
      const learner =
        a.consultation?.requestedBy?.user?.name ??
        a.subscription?.requestedBy?.user?.name ??
        a.trialSession?.consulteeProfile?.user?.name ??
        "—";
      const startMs = new Date(slot.startsAt).getTime();
      const endMs = new Date(slot.endsAt).getTime();
      const joinable =
        !slot.isTentative && nowMs >= startMs - CONSULTANT_JOIN_WINDOW_MS && nowMs <= endMs;
      return {
        id: a.id,
        type: a.appointmentType,
        startsAt: slot.startsAt,
        status: slot.completionStatus,
        learner,
        joinable,
        earning: earningsByAppointmentId.get(a.id) ?? null,
      };
    })
    .sort(
      (x, y) => new Date(x.startsAt).getTime() - new Date(y.startsAt).getTime(),
    );

  // toPlain — rateCard/earnings rows carry an inspect symbol (see serialize.ts)
  return toPlain({ orgDefaultCard, payoutAccount, earnings, upcomingSessions });
}
