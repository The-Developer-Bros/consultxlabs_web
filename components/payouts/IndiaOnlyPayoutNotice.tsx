/**
 * The platform accepts consultees worldwide and pays consultants in India only.
 *
 * Those two halves are genuinely different and are constantly conflated, so
 * this component says both in one place rather than letting each surface
 * paraphrase it. Buyers anywhere can pay — Razorpay accepts international
 * cards, converts at the buyer's bank and settles INR. Consultants are a
 * different matter: paying someone outside India means Section 195 withholding,
 * treaty relief against a tax residency certificate, and a Form 15CA/15CB
 * filing per remittance, and RazorpayX cannot pay a foreign bank account at
 * all. `processSinglePayout` therefore refuses a non-resident payout outright.
 *
 * This exists so a consultant learns that before building a profile, not after
 * earning money they cannot withdraw.
 */
import { Globe, Info } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function IndiaOnlyPayoutNotice({
  variant = "full",
  className,
}: {
  /**
   * `full` for onboarding, where the reader is deciding whether to sign up at
   * all. `compact` for surfaces where they have already joined and just need
   * the payout constraint restated.
   */
  variant?: "full" | "compact";
  className?: string;
}) {
  if (variant === "compact") {
    return (
      <p
        className={`text-xs text-muted-foreground ${className ?? ""}`}
        data-testid="india-only-payout-notice"
      >
        <Info className="mr-1 inline h-3 w-3 align-[-2px]" />
        Payouts are made to Indian bank accounts only. You can be booked and
        paid for by clients anywhere in the world.
      </p>
    );
  }

  return (
    <Alert
      className={`border-border bg-muted ${className ?? ""}`}
      data-testid="india-only-payout-notice"
    >
      <Globe className="h-4 w-4" />
      <AlertTitle className="text-foreground">
        Clients worldwide, payouts to India only
      </AlertTitle>
      <AlertDescription className="text-muted-foreground">
        Consultees can book and pay you from anywhere — international cards are
        accepted and settled in INR. To be paid, though, you need an Indian bank
        account: we withhold TDS under Section 194-O, which applies to
        residents, and our payout rail only reaches Indian accounts. Support for
        non-resident consultants is not built yet, so if you cannot receive INR
        into an Indian account, please hold off until we announce it.
      </AlertDescription>
    </Alert>
  );
}
