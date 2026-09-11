"use client";

import * as Sentry from "@sentry/nextjs";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { formatCurrencyAmount } from "@/utils/formatting";
import { Gift, Clock, Loader2, CheckCircle } from "lucide-react";

interface TrialBookingModalProps {
  isOpen: boolean;
  onClose: () => void;
  consultantProfileId: string;
  consultantName: string;
  subscriptionPlanId: string;
  planTitle: string;
  trialDurationMinutes: number;
  /** #1167 — 0 is a genuinely free trial; anything above is charged. */
  trialPriceInPaise?: number;
  /** The plan's own currency. Trials have no separate one. */
  trialCurrency?: string;
}

export function TrialBookingModal({
  isOpen,
  onClose,
  consultantProfileId,
  consultantName,
  subscriptionPlanId,
  planTitle,
  trialDurationMinutes,
  trialPriceInPaise = 0,
  trialCurrency = "INR",
}: Readonly<TrialBookingModalProps>) {
  const isPaidTrial = trialPriceInPaise > 0;
  const priceLabel = isPaidTrial
    ? formatCurrencyAmount(trialPriceInPaise, trialCurrency)
    : "Free trial";
  const { data: session } = useSession();
  const router = useRouter();
  const { toast } = useToast();
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  // Send an unauthenticated visitor to sign-in, preserving the trial intent so
  // that after auth + onboarding they land back on this expert with the trial
  // modal auto-opened (the expert page honours ?action=trial).
  const redirectToSignIn = () => {
    const returnTo = `${window.location.pathname}?action=trial`;
    router.push(`/auth/signin?callbackUrl=${encodeURIComponent(returnTo)}`);
  };

  const handleSubmit = async () => {
    if (!session?.user?.id) {
      redirectToSignIn();
      return;
    }

    try {
      setIsSubmitting(true);

      // First, get the consultee profile ID
      const profileResponse = await fetch(
        `/api/profiles/consultee?userId=${session.user.id}`,
      );
      if (!profileResponse.ok) {
        throw new Error("Failed to get your profile. Please try again.");
      }
      const { data: consulteeProfile } = await profileResponse.json();

      if (!consulteeProfile?.id) {
        throw new Error(
          "You need a consultee profile to request a trial. Please complete your profile setup.",
        );
      }

      // Check eligibility
      const eligibilityResponse = await fetch(
        `/api/trials/check-eligibility?consulteeProfileId=${consulteeProfile.id}&consultantProfileId=${consultantProfileId}&subscriptionPlanId=${subscriptionPlanId}`,
      );
      if (!eligibilityResponse.ok) {
        throw new Error("Failed to check eligibility");
      }
      const { data: eligibility } = await eligibilityResponse.json();

      if (!eligibility.isEligible) {
        toast({
          title: "Not Eligible",
          description:
            eligibility.reason ||
            "You are not eligible for a trial with this consultant",
          variant: "destructive",
        });
        return;
      }

      // Submit trial request
      const response = await fetch("/api/trials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consulteeProfileId: consulteeProfile.id,
          consultantProfileId,
          subscriptionPlanId,
          notes: notes.trim() || null,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to submit trial request");
      }

      setIsSuccess(true);
      toast({
        title: "Trial Requested!",
        description: `Your trial request has been sent to ${consultantName}. They will contact you to schedule the session.`,
      });

      // Auto close after success
      setTimeout(() => {
        onClose();
        setIsSuccess(false);
        setNotes("");
      }, 2000);
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
      console.error("Error requesting trial:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to request trial",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!session?.user?.id) {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-[425px] z-[1002]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Gift className="h-5 w-5 text-emerald-500" />
              Book Trial
            </DialogTitle>
            <DialogDescription>
              Sign in to request a trial session
            </DialogDescription>
          </DialogHeader>
          <div className="py-6 text-center">
            <p className="text-muted-foreground mb-4">
              Please sign in to request a trial with {consultantName}
            </p>
            <Button onClick={redirectToSignIn}>
              Sign In to Continue
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (isSuccess) {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-[425px] z-[1002]">
          <div className="py-8 text-center">
            <div className="mx-auto w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mb-4">
              <CheckCircle className="h-8 w-8 text-emerald-600" />
            </div>
            <h3 className="text-xl font-semibold text-foreground mb-2">
              Trial Requested!
            </h3>
            <p className="text-muted-foreground">
              {consultantName} will review your request and get back to you
              soon.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px] z-[1002]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gift className="h-5 w-5 text-emerald-500" />
            Book Trial Session
          </DialogTitle>
          <DialogDescription>
            Request a {trialDurationMinutes}-minute trial with{" "}
            {consultantName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Plan Info — the price is the first thing shown. Requesting a
              trial used to name no number anywhere, so a paid trial read as
              free right up until the payment link arrived. */}
          <div className="bg-muted rounded-lg p-4">
            <p className="text-sm font-medium text-foreground">{planTitle}</p>
            <div className="flex items-center justify-between gap-3 mt-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-4 w-4" />
                <span>{trialDurationMinutes} minute trial</span>
              </div>
              <span
                className={`text-sm font-semibold ${
                  isPaidTrial ? "text-foreground" : "text-emerald-600"
                }`}
              >
                {priceLabel}
              </span>
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">
              What would you like to discuss? (Optional)
            </Label>
            <Textarea
              id="notes"
              placeholder="Share your goals, questions, or topics you'd like to cover in the trial session..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="min-h-[100px]"
            />
            <p className="text-xs text-muted-foreground">
              This helps the consultant prepare for your session
            </p>
          </div>

          {/* Info — say when money changes hands. Nothing is charged at
              request time either way; a paid trial bills on acceptance. */}
          <div className="bg-muted rounded-lg p-4 text-sm text-muted-foreground">
            <p>
              After submitting, the consultant will review your request and
              contact you to schedule a time that works for both of you.
            </p>
            {isPaidTrial && (
              <p className="mt-2">
                You won&apos;t be charged now — we send a payment link for{" "}
                <strong className="text-foreground">{priceLabel}</strong> after
                the consultant accepts, and your slot is held until you pay it.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Requesting...
              </>
            ) : (
              <>
                <Gift className="h-4 w-4 mr-2" />
                Request Trial
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
