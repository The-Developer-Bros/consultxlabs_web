import prisma from "@/lib/prisma";
import { CLASS_PREFIX, WEBINAR_PREFIX } from "@/lib/stream-channel-ids";

/**
 * Resolve the group chat channel ids attached to a set of appointments.
 *
 * Only webinar and class produce a group (`team`) channel. Consultations and
 * subscriptions produce a DM between the pair, which is deliberately NOT
 * returned here: freezing a DM during maintenance would silence a private
 * conversation that has nothing to do with the session being drained, and the
 * pair's thread outlives any single appointment.
 *
 * Used by the maintenance drain (#1134 P1-4) and, later, by the post-event
 * freeze/purge lifecycle.
 */
export async function getEventChannelIdsForAppointment(
  appointmentIds: string[],
): Promise<string[]> {
  if (appointmentIds.length === 0) return [];

  const appointments = await prisma.appointment.findMany({
    where: { id: { in: appointmentIds } },
    select: {
      webinar: { select: { id: true } },
      class: { select: { id: true } },
    },
  });

  const channelIds = new Set<string>();
  for (const appointment of appointments) {
    if (appointment.webinar) {
      channelIds.add(`${WEBINAR_PREFIX}${appointment.webinar.id}`);
    }
    if (appointment.class) {
      channelIds.add(`${CLASS_PREFIX}${appointment.class.id}`);
    }
  }
  return Array.from(channelIds);
}
