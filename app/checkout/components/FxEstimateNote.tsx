"use client";

import { useMemo } from "react";
import { useSession } from "@/lib/auth-client";
import { useCurrency } from "@/hooks/useCurrency";
import { RATE_PROVIDER_NAME, RATE_PROVIDER_URL } from "@/lib/currency-codes";
import { formatCurrencyAmount } from "@/utils/formatting";

/**
 * The disclosure sentence for one (currency, total, funding source) triple.
 *
 * #1414 — extracted from the component body as a chain of early returns. As a
 * nested ternary it tripped the quality gate twice, and the zero-total case
 * below had nowhere to go: referral credits that cover a booking in full skip
 * the gateway entirely, so the default sentence promised a gateway charge that
 * never happens.
 */
function estimateLead(
  currency: string,
  totalPaise: number,
  fundingSource: string | null,
) {
  const inr = formatCurrencyAmount(totalPaise, "INR");

  if (totalPaise <= 0) {
    return (
      <>
        Estimated in {currency}. Nothing is payable for this booking, so no
        gateway payment is required.
      </>
    );
  }

  if (fundingSource === "WALLET") {
    return (
      <>
        Estimated in {currency}. Your organisation&rsquo;s wallet will be
        debited {inr} in INR; no card is charged.
      </>
    );
  }

  if (fundingSource === "INVOICE") {
    return (
      <>
        Estimated in {currency}. {inr} in INR will be billed to your
        organisation&rsquo;s invoice account; no card is charged.
      </>
    );
  }

  if (fundingSource === "LICENSE") {
    return (
      <>
        Estimated in {currency}. The session value is {inr} in INR and is
        covered by your enterprise licence.
      </>
    );
  }

  return (
    <>
      Estimated in {currency}. You will be charged {inr} in INR by the payment
      gateway; your card issuer&rsquo;s rate applies.
    </>
  );
}

/**
 * #1396 — every order-summary line on the four checkout pages, the Total
 * included, is rendered through `useCurrency().formatPrice`, which multiplies
 * INR paise by a live rate and stamps a foreign symbol on the result. The
 * Razorpay modal then opens with the server's INR amount and the confirmation
 * email is written in INR, so a buyer who had selected USD read "$59.38", was
 * charged ₹5,000.00, and was emailed "₹5,000.00" — with the mid-market-versus-
 * card-network spread and the gateway's markup, typically two to four percent,
 * unaccounted for anywhere on the page.
 *
 * This component is the disclosure. It renders only while the figures above it
 * really are an estimate, names the INR amount that will actually be taken, and
 * carries the attribution that the rate provider's licence requires wherever
 * its rates are displayed.
 *
 * It exists as one shared component rather than four copies so the four
 * checkout pages each add a single line, which also keeps the duplication ratio
 * on new code inside the quality gate.
 */
export function FxEstimateNote({
  totalPaise,
  organizationId,
}: {
  totalPaise: number;
  /**
   * #1414 — the selected org, when the buyer is booking against one. Only
   * PERSONAL funding (and no org at all) reaches a payment gateway; WALLET
   * debits the credit pool, INVOICE defers to NET-X billing and LICENSE
   * charges nothing, so naming a gateway charge in those flows is false.
   */
  organizationId?: string | null;
}) {
  const { currency, isEstimate } = useCurrency();
  const { data: session } = useSession();
  const fundingSource = useMemo(() => {
    if (!organizationId) return null;
    const memberships = session?.user?.organizationMemberships ?? [];
    return (
      memberships.find((m) => m.organizationId === organizationId)
        ?.fundingSource ?? null
    );
  }, [organizationId, session?.user?.organizationMemberships]);

  if (!isEstimate) return null;

  return (
    <p className="text-xs text-muted-foreground">
      {estimateLead(currency, totalPaise, fundingSource)} Rates by{" "}
      <a
        href={RATE_PROVIDER_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 hover:text-foreground"
      >
        {RATE_PROVIDER_NAME}
      </a>
      .
    </p>
  );
}
