"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/utils/tailwind";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

type CheckoutBackButtonProps = {
  /**
   * Where to go when there is nothing to go back to (deep link, first-time
   * sign-in + onboarding redirect left no in-tab history). The page replaces
   * to this — pushing would let a later "Back" land back on checkout.
   */
  sourceHref: string;
  className?: string;
};

/**
 * Smart back button shared across checkout. Tries the browser/Next history
 * first; falls back to `sourceHref` when the tab has no in-app history
 * (`history.length === 1`, e.g. a fresh deep link or a user who was just
 * routed through sign-in + onboarding via `router.replace`).
 *
 * The onboarding-wizard edge is self-healing downstream: an onboarded user who
 * somehow lands back on `/form/onboarding` is bounced to `/dashboard` by
 * `requireNotOnboarded`, so we never loop them back into the wizard.
 */
export function CheckoutBackButton({
  sourceHref,
  className,
}: CheckoutBackButtonProps) {
  const router = useRouter();

  const handleBack = () => {
    if (window.history.length > 1) {
      router.back();
    } else {
      router.replace(sourceHref);
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleBack}
      className={cn(
        "gap-1.5 text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      <ArrowLeft className="h-4 w-4" />
      Back
    </Button>
  );
}
