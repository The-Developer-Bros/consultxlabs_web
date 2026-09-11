import prisma from "@/lib/prisma";
import { toPlain } from "@/lib/data/serialize";
import { readAppointmentDetail } from "@/lib/data/appointment-detail";
import { resolvePlanOwnerIds } from "@/lib/booking/plan-owners";
import { toSlotLike } from "@/lib/appointments/view-model";
import type { ManageTimingsAppointmentLike } from "@/lib/scheduling/manage-timings-subject";

/**
 * Resolves the id in `/appointments/[appointmentId]/timings` to the data the
 * page needs, for both of that segment's meanings.
 *
 * A scheduled instance (consultation/subscription/webinar/class that already
 * has an `Appointment` row) is looked up by that row's id, same as the
 * sibling reschedule route. An UNSCHEDULED webinar/class has no `Appointment`
 * row at all — that is what "unscheduled" means — so it travels as a
 * synthetic id (`unscheduled-class-<id>` / `unscheduled-webinar-<id>`), the
 * same prefix the consultant appointments list already used client-side
 * before this route existed.
 */

const UNSCHEDULED_CLASS_PREFIX = "unscheduled-class-";
const UNSCHEDULED_WEBINAR_PREFIX = "unscheduled-webinar-";

const collaboratorsInclude = {
  where: { status: "ACCEPTED" as const },
  select: { consultantProfileId: true },
} as const;

export interface ManageTimingsTarget {
  appointment: ManageTimingsAppointmentLike;
  /** Plan owner + ACCEPTED collaborators — the page's ownership check. */
  planOwnerIds: string[];
  /** Program progress; only set when this id groups several sessions
   *  (subscription/class with siblings). */
  completedSessions?: number;
  groupTotalSessions?: number;
}

function isCompleted(slots: { endsAt: string | Date }[]): boolean {
  if (slots.length === 0) return false;
  const now = Date.now();
  return slots.every((slot) => new Date(slot.endsAt).getTime() < now);
}

function ownerIds(...ids: (string | null | undefined)[]): string[] {
  return ids.filter((id): id is string => Boolean(id));
}

export async function readManageTimingsTarget(
  targetId: string,
): Promise<ManageTimingsTarget | null> {
  if (targetId.startsWith(UNSCHEDULED_CLASS_PREFIX)) {
    const id = targetId.slice(UNSCHEDULED_CLASS_PREFIX.length);
    const classRow = await prisma.class.findUnique({
      where: { id },
      include: {
        classPlan: { include: { collaborators: collaboratorsInclude } },
      },
    });
    if (!classRow?.classPlan) return null;

    return toPlain<ManageTimingsTarget>({
      appointment: {
        appointmentType: "CLASS",
        class: {
          id: classRow.id,
          schedulingPeriodStartsAt: classRow.schedulingPeriodStartsAt,
          schedulingPeriodEndsAt: classRow.schedulingPeriodEndsAt,
          classPlan: classRow.classPlan,
        },
      },
      planOwnerIds: ownerIds(
        classRow.classPlan.consultantProfileId,
        ...classRow.classPlan.collaborators.map((c) => c.consultantProfileId),
      ),
    });
  }

  if (targetId.startsWith(UNSCHEDULED_WEBINAR_PREFIX)) {
    const id = targetId.slice(UNSCHEDULED_WEBINAR_PREFIX.length);
    const webinarRow = await prisma.webinar.findUnique({
      where: { id },
      include: {
        webinarPlan: { include: { collaborators: collaboratorsInclude } },
      },
    });
    if (!webinarRow?.webinarPlan) return null;

    return toPlain<ManageTimingsTarget>({
      appointment: {
        appointmentType: "WEBINAR",
        webinar: { id: webinarRow.id, webinarPlan: webinarRow.webinarPlan },
      },
      planOwnerIds: ownerIds(
        webinarRow.webinarPlan.consultantProfileId,
        ...webinarRow.webinarPlan.collaborators.map(
          (c) => c.consultantProfileId,
        ),
      ),
    });
  }

  // A real Appointment row: same read the reschedule/detail pages already
  // use, so eligibility and the ownership shape stay in one place.
  const detail = await readAppointmentDetail(targetId);
  if (!detail) return null;
  const { appointment, siblings } = detail;

  // TRIAL sessions never open this surface — the appointments list never
  // renders a "Timings" action for one — but the type is wider than the
  // four this route understands, so guard rather than assume.
  if (
    appointment.appointmentType !== "CONSULTATION" &&
    appointment.appointmentType !== "SUBSCRIPTION" &&
    appointment.appointmentType !== "WEBINAR" &&
    appointment.appointmentType !== "CLASS"
  ) {
    return null;
  }

  const planOwnerIds = resolvePlanOwnerIds(appointment);

  // A subscription/class session is one Appointment among several; progress
  // is only meaningful across the whole program, same as the consultant
  // appointments list's group card (map-consultant.ts's mapGroup).
  const program =
    appointment.appointmentType === "SUBSCRIPTION" ||
    appointment.appointmentType === "CLASS"
      ? [appointment, ...siblings]
      : null;
  const scheduled = program?.filter(
    (row) => row.slotsOfAppointment.length > 0,
  );

  // The PLAN's count, not the number of Appointment rows that happen to carry
  // slots. Siblings are real appointments, not session placeholders, so an
  // unscheduled one is simply absent — counting rows made the total shrink to
  // whatever was already scheduled, and "remaining" then folded completed
  // sessions in with future ones.
  const groupTotalSessions =
    appointment.appointmentType === "SUBSCRIPTION"
      ? (appointment.subscription?.subscriptionPlan?.totalSessions ?? undefined)
      : appointment.appointmentType === "CLASS"
        ? (appointment.class?.classPlan?.totalSessions ?? undefined)
        : undefined;

  return {
    // Narrowed shape only: the guard above already ruled out TRIAL, but Prisma's
    // enum comparison doesn't narrow `appointment.appointmentType` for TS, and
    // this also keeps payment/organization/trialSession off a type this route
    // never reads.
    appointment: {
      appointmentType: appointment.appointmentType as
        | "CONSULTATION"
        | "SUBSCRIPTION"
        | "WEBINAR"
        | "CLASS",
      // Program-wide, past sessions included: the picker opens on the earliest
      // session still awaiting a time, and falls back to the last one that
      // ran when everything is over (#1073).
      //
      // Through `toSlotLike`, never spread: these rows arrive from an
      // `include` and carry the attendee list and recording URLs with them,
      // which this route has no business shipping to the client.
      slots: [
        ...appointment.slotsOfAppointment,
        ...siblings.flatMap((sibling) => sibling.slotsOfAppointment),
      ].map(toSlotLike),
      consultation: appointment.consultation,
      subscription: appointment.subscription,
      webinar: appointment.webinar,
      class: appointment.class,
    },
    planOwnerIds,
    completedSessions: scheduled
      ? scheduled.filter((row) => isCompleted(row.slotsOfAppointment)).length
      : undefined,
    groupTotalSessions,
  };
}
