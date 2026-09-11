import { ENABLE_LIVE_PAYOUTS } from "@/lib/feature-flags";
import { recordSystemError } from "@/lib/enterprise/system-events";
import {
  getRazorpayPayoutsService,
  isRazorpayPayoutsConfigured,
} from "./razorpay-payouts";

export type BalancePreflight = {
  /** False only on a KNOWN-insufficient balance — the caller holds the batch. */
  ok: boolean;
  /** Fetched balance in paise, or null when unknown (not fetched / bad shape). */
  balancePaise: number | null;
  reason?: string;
};

/**
 * #863 — pre-batch RazorpayX balance check. Runs only when live payouts are on
 * and the gateway is configured (otherwise nothing is wired to leave, so it's a
 * no-op ok). On a KNOWN-insufficient balance it pages ops and returns ok:false,
 * so the caller holds the batch — the rows stay PENDING, the same honest posture
 * as the flag-off path, instead of half-submitting and stranding NEFT.
 *
 * A balance-read failure or unexpected shape fails OPEN (ok:true): a brand-new
 * read dependency must never stall payouts, and RazorpayX's own
 * `queue_if_low_balance` remains the gateway-side backstop.
 *
 * Fail-open is deliberate and stays. What changed is that it is no longer
 * SILENT. `getAccountBalance` swallows every error and returns null, and its
 * own source comment admits the endpoint "must be re-verified against the
 * sandbox before ENABLE_LIVE_PAYOUTS flips" — so a wrong URL or a changed
 * response shape would turn this guard into a permanent no-op with nothing
 * anywhere saying so, on the one code path that runs immediately before real
 * money leaves. An unknown balance now pages at WARN severity: payouts still
 * proceed, but somebody finds out the guard is blind.
 */
export async function assertPayoutBalance(
  totalPaise: number,
): Promise<BalancePreflight> {
  if (!ENABLE_LIVE_PAYOUTS || !isRazorpayPayoutsConfigured()) {
    return { ok: true, balancePaise: null };
  }

  const balancePaise = await getRazorpayPayoutsService().getAccountBalance();
  if (balancePaise === null) {
    const reason =
      "RazorpayX balance unknown (read failed or returned an unexpected shape) — " +
      "proceeding on queue_if_low_balance, but the pre-batch balance guard is blind";
    void recordSystemError({
      organizationId: null,
      category: "PAYOUT",
      summary: `RAZORPAYX_BALANCE_UNKNOWN — ${reason}`,
      err: new Error(reason),
      context: { totalPaise },
    }).catch(() => {});
    return { ok: true, balancePaise: null, reason }; // unknown → fail open, loudly
  }
  if (balancePaise < totalPaise) {
    const reason = `RazorpayX balance ${balancePaise} < required ${totalPaise} paise`;
    void recordSystemError({
      organizationId: null,
      category: "PAYOUT",
      summary: `RAZORPAYX_BALANCE_INSUFFICIENT — ${reason}`,
      err: new Error(reason),
      context: { balancePaise, totalPaise },
    }).catch(() => {});
    return { ok: false, balancePaise, reason };
  }
  return { ok: true, balancePaise };
}
