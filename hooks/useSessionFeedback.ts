/**
 * #705 / #1540 — this viewer's per-call ratings for a whole BOOKING, keyed by slot.
 *
 * ONE request, not one per child appointment. The sessions of a subscription each
 * belong to a different child `Appointment`, and this hook used to fan out a
 * request per id through `useQueries` — up to 25 for one booking, each of them
 * re-authorizing and re-reading the appointment graph, so rendering a single page
 * cost roughly a hundred Prisma operations. Under `PG_POOL_MAX=1` on Netlify every
 * one of those serialises, so the parallelism `useQueries` appeared to buy did not
 * exist at the database.
 *
 * `scope=booking` widens the server's answer to the booking and its siblings, which
 * costs it no extra query because the authorization it already performed had loaded
 * them.
 */

import { useQuery } from "@tanstack/react-query";
import { throwSupportError } from "@/lib/support/error-copy";

interface SlotFeedback {
  slotOfAppointmentId: string | null;
  rating: number;
}

/** The one cache key for a booking's ratings.
 *
 *  Exported because `SessionRatingRow` writes a rating for a CHILD appointment and
 *  has to invalidate the BOOKING's entry — invalidating its own child id would
 *  leave the stars unchanged after a save, which is the bug the per-appointment
 *  keys created the moment the reads were consolidated. */
export const bookingFeedbackKey = (bookingAppointmentId: string) =>
  ["booking-feedback", bookingAppointmentId] as const;

export interface SessionFeedbackState {
  /** slot id → the rating this viewer gave it. */
  ratings: Record<string, number>;
  /** Slots this viewer may rate at all — attended, or offline. */
  rateable: Set<string>;
  /**
   * True when the read failed.
   *
   * The query throws so React Query records the failure and retries, but the
   * aggregation below reads optional data — so a failed read contributed no
   * ratings and no rateable slots, which renders identically to "you have rated
   * nothing here and may rate nothing here". A transient 500 would tell somebody
   * their rating never happened.
   */
  isError: boolean;
  /** Re-run the read. */
  retry: () => void;
}

export function useSessionFeedback(
  bookingAppointmentId: string,
): SessionFeedbackState {
  const query = useQuery({
    queryKey: bookingFeedbackKey(bookingAppointmentId),
    queryFn: async (): Promise<{
      ratings: Record<string, number>;
      rateable: string[];
    }> => {
      const res = await fetch(
        `/api/appointments/${bookingAppointmentId}/feedback?scope=booking`,
      );
      // A failed read is NOT "you have rated nothing". Returning an empty result
      // made React Query record success, skip its retry and cache the emptiness,
      // so a 500 rendered as unrated stars on a call the user had already rated.
      if (!res.ok) await throwSupportError(res, "session feedback load");
      const { data, rateableSlotIds } = await res.json();
      const rows = (data ?? []) as SlotFeedback[];
      // A provider's read returns EVERY attendee's rating, so a group call yields
      // several rows for one slot. `Object.fromEntries` kept whichever came last —
      // the consultant saw one arbitrary attendee's score and read it as the
      // session's. Averaged instead, which is also how that call contributes to
      // the group score.
      const bySlot = new Map<string, { total: number; n: number }>();
      for (const r of rows) {
        if (!r.slotOfAppointmentId) continue;
        const acc = bySlot.get(r.slotOfAppointmentId) ?? { total: 0, n: 0 };
        acc.total += r.rating;
        acc.n += 1;
        bySlot.set(r.slotOfAppointmentId, acc);
      }
      return {
        ratings: Object.fromEntries(
          [...bySlot].map(([slotId, a]) => [
            slotId,
            Math.round((a.total / a.n) * 10) / 10,
          ]),
        ),
        rateable: (rateableSlotIds ?? []) as string[],
      };
    },
  });

  return {
    ratings: query.data?.ratings ?? {},
    rateable: new Set(query.data?.rateable ?? []),
    isError: query.isError,
    retry: () => void query.refetch(),
  };
}
