import { provisionAppointmentMeeting } from "@/actions/stream/meetings/meeting.action";
import { userFacingError } from "@/lib/errors/classification/client-failure";
import type { AppointmentsType } from "@prisma/client";

/**
 * Minimal slot interface for meeting operations.
 * This defines only what getOrCreateAppointmentMeeting actually uses.
 * Both TSlotOfAppointment and SlotOfAppointment satisfy this interface.
 */
export interface MeetingSlot {
  id: string;
  startsAt: Date | string;
  endsAt: Date | string | null;
  isTentative?: boolean;
  appointmentId?: string | null;
}

/**
 * Minimal appointment interface the join surfaces pass around.
 *
 * #1270 — nothing on it reaches Stream any more. The room's title, its
 * organization tag and the `consultantUserId` the meeting UI derives host-ness
 * from are all resolved server-side from the slot's own rows, because a value
 * the browser supplies is a value the browser can choose. What remains is what
 * the CALLERS use it for: picking a slot to join and naming the appointment in
 * a failure report.
 */
export interface MeetingAppointment {
  id: string;
  appointmentType: AppointmentsType;
  slotsOfAppointment: MeetingSlot[];
  organizationId?: string | null;
  consultantUserId?: string | null;
  consulteeUserId?: string | null;
  consultation?: {
    requestedBy?: { user?: { name?: string | null } | null } | null;
    consultationPlan?: { title?: string | null } | null;
  } | null;
  subscription?: {
    requestedBy?: { user?: { name?: string | null } | null } | null;
    subscriptionPlan?: { title?: string | null } | null;
  } | null;
  webinar?: {
    webinarPlan?: { title?: string | null } | null;
  } | null;
  class?: {
    classPlan?: { title?: string | null } | null;
  } | null;
}

/**
 * Resolves the Stream call id for a session's slot, creating the call if this
 * is the first time anyone has asked for it.
 *
 * #1270 — this used to BE the creation: it took the browser's own
 * `StreamVideoClient`, built a `Call` handle and ran `getOrCreate` from the
 * dashboard. Three consequences followed, and all three are gone now that the
 * write happens in `provisionAppointmentMeeting`:
 *
 *   - whoever pressed Join first became the call's `created_by`, which for half
 *     of all sessions is the consultee;
 *   - every field of the call's `custom` data was authored by a browser,
 *     including the one the meeting UI reads to decide who may end the call;
 *   - `getOrCreate` applies the call type's device settings, so minting a room
 *     opened the camera and microphone on the DASHBOARD. #1271 released them
 *     afterwards; there is now nothing to release, because no `Call` handle is
 *     constructed here at all.
 *
 * What is left is one round trip and the toast boundary. Refusals come back as
 * data rather than as a thrown error, because Next replaces an uncaught
 * server-action error with an opaque digest — so they are re-thrown here, on
 * the client, where the classifier shows the message verbatim.
 *
 * @param slot Any row of the session; the anchor row is resolved server-side.
 * @returns The Stream Call ID for the meeting.
 */
export const getOrCreateAppointmentMeeting = async (
  slot: MeetingSlot,
): Promise<string> => {
  if (!slot) {
    throw new Error("Slot data is missing.");
  }

  const result = await provisionAppointmentMeeting({
    id: slot.id,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    isTentative: slot.isTentative,
    appointmentId: slot.appointmentId,
  });

  if (!result.ok) throw userFacingError(result.refusal);

  return result.streamCallId;
};
