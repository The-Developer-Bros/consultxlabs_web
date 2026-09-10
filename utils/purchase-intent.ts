/**
 * Purchase-intent preservation across the auth wall (#booking-journey).
 *
 * A guest who picks a slot and hits a paywall must land back EXACTLY where
 * they were — same consultant, same plan, same selected time — after
 * sign-in/sign-up/onboarding. Two mechanisms cooperate:
 *
 * 1. `callbackUrl` (query param): carries the DESTINATION through
 *    signin → signup → verify-email → onboarding. Best for URLs whose
 *    meaning is fully encoded in the path+query (e.g. /checkout/plans/
 *    consultation/<id>?startsAt=...&endsAt=...).
 *
 * 2. This module (sessionStorage): carries STATE THAT ISN'T IN THE URL —
 *    currently the request-for-approval flow's selected slot, which returns
 *    the user to the expert PROFILE page (the calendar lives there) and
 *    would otherwise lose their pick, forcing a re-selection.
 *
 * sessionStorage (not localStorage): intent is single-session by definition;
 * a user returning next week should re-pick rather than be teleported into a
 * stale booking. Every reader consumes-and-clears, and everything is guarded
 * — private-mode Safari throws on storage access, and a corrupt payload must
 * never break the profile page.
 */

export interface StashedPurchaseIntent {
  /** Which expert profile this belongs to; consumers ignore foreign intents. */
  consultantId: string;
  consultationPlanId: string;
  slot: {
    startsAt: string;
    endsAt: string;
    type?: "WEEKLY" | "CUSTOM";
    slotOfAvailabilityId?: string;
  };
}

const STORAGE_KEY = "familiarise:pendingPurchaseIntent";

export function stashPurchaseIntent(intent: StashedPurchaseIntent): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(intent));
  } catch {
    // Storage unavailable (private mode / quota) — degradation is acceptable:
    // the user simply re-picks their slot after auth.
  }
}

/**
 * Read-and-clear the stashed intent. When `consultantId` is given, intents
 * belonging to a different profile are ignored (but still cleared — a stale
 * intent has no second chance).
 */
export function consumePurchaseIntent(
  consultantId?: string,
): StashedPurchaseIntent | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(STORAGE_KEY);

    const parsed = JSON.parse(raw) as Partial<StashedPurchaseIntent> | null;
    if (
      !parsed ||
      typeof parsed.consultantId !== "string" ||
      typeof parsed.consultationPlanId !== "string" ||
      typeof parsed.slot?.startsAt !== "string" ||
      typeof parsed.slot?.endsAt !== "string"
    ) {
      return null;
    }
    if (consultantId && parsed.consultantId !== consultantId) return null;

    return parsed as StashedPurchaseIntent;
  } catch {
    return null;
  }
}
