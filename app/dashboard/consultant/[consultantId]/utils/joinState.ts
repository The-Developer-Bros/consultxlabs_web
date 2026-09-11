import type { TSlotOfAppointment } from "@/types/appointment";
import {
  CONSULTANT_JOIN_WINDOW_MS,
  getJoinableSlot as getJoinableSlotShared,
} from "@/lib/appointments/slots";

/** Consultant join-window resolution — thin wrapper over the shared slot
 *  predicate (lib/appointments/slots) with the consultant's 15-min window. */
export function getJoinableSlot(
  slots: TSlotOfAppointment[],
): TSlotOfAppointment | null {
  return getJoinableSlotShared(slots, {
    joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
  });
}
