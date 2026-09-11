import Link from "next/link";
import { Lock } from "lucide-react";

interface BillingBlockBannerProps {
  walletFrozen: boolean;
  walletFrozenReason?: string | null;
  dunningSuspended: boolean;
  /** Support deep-link — kept a prop rather than hardcoded so callers on
   *  different surfaces (billing page vs. org home) can each point at
   *  whatever support entry point they already render. */
  supportHref: string;
}

/**
 * #1427/#1430 — one banner for both silent-block states so the two never
 * drift into slightly different copy/styling (Sonar's 3% new-code
 * duplication gate would also just fail a second near-identical component).
 * Freeze takes priority when both are somehow true at once — it is the more
 * severe state (ops has to reconcile a balance, not just collect a payment).
 */
export function BillingBlockBanner({
  walletFrozen,
  walletFrozenReason,
  dunningSuspended,
  supportHref,
}: BillingBlockBannerProps) {
  if (!walletFrozen && !dunningSuspended) return null;

  const message = walletFrozen
    ? (walletFrozenReason ??
      "Wallet spend is paused pending a balance-reconciliation review.")
    : "Bookings are paused until the overdue invoice is settled.";

  return (
    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
      <Lock className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        {message}{" "}
        <Link href={supportHref} className="font-medium underline">
          Contact support
        </Link>{" "}
        for help resolving this.
      </p>
    </div>
  );
}
