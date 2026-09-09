/**
 * #705 — this viewer's per-call ratings for one booking, keyed by slot id.
 *
 * The feedback GET returns every call of the booking the caller has rated, so
 * the session timeline can show which are already rated without a request per
 * row.
 */

import { useQueries } from "@tanstack/react-query";
import { throwSupportError } from "@/lib/support/error-copy";

interface SlotFeedback {
  slotOfAppointmentId: string | null;
  rating: number;
}

/**
 * Sessions in a subscription or class group belong to DIFFERENT appointments —
 * `SessionVM.appointmentId` differs per row — so fetching only the page's own
 * appointment left every child session looking unrated, and its invalidation
 * key pointed at the wrong query.
 */
export interface SessionFeedbackState {
  /** slot id → the rating this viewer gave it. */
  ratings: Record<string, number>;
  /** Slots this viewer may rate at all — attended, or offline. */
  rateable: Set<string>;
  /**
   * True when ANY of the per-appointment reads failed.
   *
   * The hook throws per query so React Query records the failure and retries,
   * but the aggregation below reads `r.data?` — so a failed appointment
   * contributed no ratings and no rateable slots, which renders exactly like
   * "you have rated nothing here and may rate nothing here". The consumer has
   * to be able to tell those apart, or a transient 500 silently tells someone
   * their rating never happened.
   */
  isError: boolean;
  /** Re-run just the reads that failed. */
  retry: () => void;
}

export function useSessionFeedback(
  appointmentIds: readonly string[],
): SessionFeedbackState {
  const results = useQueries({
    queries: appointmentIds.map((appointmentId) => ({
      queryKey: ["appointment-feedback", appointmentId],
      queryFn: async (): Promise<{
        ratings: Record<string, number>;
        rateable: string[];
      }> => {
        const res = await fetch(`/api/appointments/${appointmentId}/feedback`);
        // A failed read is NOT "you have rated nothing". Returning an empty
        // result made React Query record success, skip its retry and cache the
        // emptiness, so a 500 rendered as unrated stars on a call the user had
        // already rated — indistinguishable from the truth. Throw and let the
        // consumer decide, which is the rule SessionReviewCard already states.
        if (!res.ok) await throwSupportError(res, "session feedback load");
        const { data, rateableSlotIds } = await res.json();
        const rows = (data ?? []) as SlotFeedback[];
        // A provider's read returns EVERY attendee's rating, so a group call
        // yields several rows for one slot. `Object.fromEntries` kept whichever
        // came last — the consultant saw one arbitrary attendee's score and
        // read it as the session's. Averaged instead, which is also how that
        // call contributes to the rating unit.
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
    })),
  });
  return {
    ratings: Object.assign({}, ...results.map((r) => r.data?.ratings ?? {})),
    rateable: new Set(results.flatMap((r) => r.data?.rateable ?? [])),
    isError: results.some((r) => r.isError),
    // Not memoized on purpose: `results` is a fresh array every render, so a
    // useCallback keyed on it would be recreated anyway, and the identity of
    // this function is not a render input anywhere.
    retry: () => {
      for (const r of results) if (r.isError) void r.refetch();
    },
  };
}
