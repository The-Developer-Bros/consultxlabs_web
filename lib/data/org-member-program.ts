/**
 * Data layer for /dashboard/organization/[orgId]/my-program (LEARNER per-org
 * view). Server-only reads, extracted out of the RSC page so the page stays a
 * thin renderer and the queries are reusable + unit-testable (repo convention:
 * lib/data/* for RSC read-fetchers). #777 §C.
 *
 * Money state here (overage owed) is read fresh on every request — never cache
 * it (see the v2 money-safety rule); staleness would mislead a learner about
 * what they owe.
 */
import prisma from "@/lib/prisma";
import { toPlain } from "@/lib/data/serialize";
// #1270 — the shared learner window, not a local copy of its value. Real join
// (Stream client) lives on the consultee dashboard; the page links there, so
// the two must agree on when the affordance appears.
import { CONSULTEE_JOIN_WINDOW_MS } from "@/lib/appointments/slots";

interface UpcomingSession {
  id: string;
  type: string;
  title: string;
  startsAt: Date;
  joinable: boolean;
}

export async function getMyProgramData(params: {
  orgId: string;
  membershipId: string;
  userId: string;
  consulteeProfileId: string | null;
}) {
  const { orgId, membershipId, userId, consulteeProfileId } = params;
  const now = new Date();
  const nowMs = now.getTime();

  // Active assignments for this membership in the current cycle. Latest first.
  const assignments = await prisma.programAssignment.findMany({
    where: {
      membershipId,
      periodStart: { lte: now },
      periodEnd: { gte: now },
    },
    orderBy: { periodStart: "desc" },
    include: {
      program: {
        include: {
          licensedSeatConfig: true,
          creditPoolConfig: true,
          contract: { select: { id: true, status: true } },
        },
      },
    },
  });

  // Latest 20 utilizations across this membership's assignments. Pull the
  // assignmentId set first so the WHERE stays index-friendly.
  const allAssignmentIds = await prisma.programAssignment.findMany({
    where: { membershipId },
    select: { id: true },
  });
  const utilizations = allAssignmentIds.length
    ? await prisma.bookingUtilization.findMany({
        where: {
          programAssignmentId: { in: allAssignmentIds.map((a) => a.id) },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
        include: {
          payment: {
            select: {
              id: true,
              appointment: { select: { id: true, appointmentType: true } },
            },
          },
        },
      })
    : [];

  // #748 — upcoming org-funded sessions for THIS learner. Appointment is
  // polymorphic; the learner participates as consultee (Consultation/
  // Subscription/Trial requester) or as a slot participant (Webinar/Class).
  const upcomingAppointments = await prisma.appointment.findMany({
    where: {
      organizationId: orgId,
      slotsOfAppointment: { some: { endsAt: { gte: now } } },
      OR: [
        ...(consulteeProfileId
          ? [
              { consultation: { requestedById: consulteeProfileId } },
              { subscription: { requestedById: consulteeProfileId } },
              { trialSession: { consulteeProfileId } },
            ]
          : []),
        { slotsOfAppointment: { some: { user: { some: { id: userId } } } } },
      ],
    },
    select: {
      id: true,
      appointmentType: true,
      slotsOfAppointment: {
        where: { endsAt: { gte: now } },
        orderBy: { startsAt: "asc" },
        take: 1,
        select: { startsAt: true, endsAt: true, isTentative: true },
      },
      consultation: {
        select: {
          cancelledAt: true,
          consultationPlan: { select: { title: true } },
        },
      },
      subscription: {
        select: { subscriptionPlan: { select: { title: true } } },
      },
      webinar: { select: { webinarPlan: { select: { title: true } } } },
      class: { select: { classPlan: { select: { title: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const upcomingSessions: UpcomingSession[] = upcomingAppointments
    .filter(
      (a) => a.slotsOfAppointment.length > 0 && !a.consultation?.cancelledAt,
    )
    .map((a) => {
      const slot = a.slotsOfAppointment[0];
      const title =
        a.consultation?.consultationPlan?.title ??
        a.subscription?.subscriptionPlan?.title ??
        a.webinar?.webinarPlan?.title ??
        a.class?.classPlan?.title ??
        a.appointmentType;
      const startMs = new Date(slot.startsAt).getTime();
      const endMs = new Date(slot.endsAt).getTime();
      const joinable =
        !slot.isTentative && nowMs >= startMs - CONSULTEE_JOIN_WINDOW_MS && nowMs <= endMs;
      return {
        id: a.id,
        type: a.appointmentType,
        title,
        startsAt: slot.startsAt,
        joinable,
      };
    })
    .sort(
      (x, y) => new Date(x.startsAt).getTime() - new Date(y.startsAt).getTime(),
    );

  // #777 §C.5/§F — outstanding member-owed overage for this learner (paise).
  // Mirrors the /dashboard/overage filter so the deep-link is consistent.
  const memberOverages = await prisma.overageEvent.findMany({
    where: {
      overageBehavior: "CHARGE_MEMBER",
      chargeStatus: { in: ["PENDING", "FAILED"] },
      payment: { is: { userId } },
    },
    select: { marginalPaise: true, programAssignmentId: true },
  });
  const outstandingOveragePaise = memberOverages.reduce(
    (sum, o) => sum + o.marginalPaise,
    0,
  );
  const overagePaiseByAssignment = memberOverages.reduce<
    Record<string, number>
  >((acc, o) => {
    acc[o.programAssignmentId] =
      (acc[o.programAssignmentId] ?? 0) + o.marginalPaise;
    return acc;
  }, {});

  // #777 §C.2 (SCHEMA-FREE) — active programs under the org's active contracts
  // this learner is NOT yet assigned to. Read-only discovery; assignment stays
  // a MAINTAINER action — single or bulk (#1230 wave-9 auto-enroll) — with no
  // self-service enrollment-request model.
  const assignedProgramIds = new Set(assignments.map((a) => a.program.id));
  const eligiblePrograms = (
    await prisma.program.findMany({
      where: {
        status: "ACTIVE",
        contract: { organizationId: orgId, status: "ACTIVE" },
      },
      select: { id: true, name: true, type: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    })
  ).filter((p) => !assignedProgramIds.has(p.id));

  // toPlain — assignment/utilization rows carry an inspect symbol (see serialize.ts)
  return toPlain({
    assignments,
    utilizations,
    upcomingSessions,
    outstandingOveragePaise,
    overagePaiseByAssignment,
    eligiblePrograms,
  });
}
