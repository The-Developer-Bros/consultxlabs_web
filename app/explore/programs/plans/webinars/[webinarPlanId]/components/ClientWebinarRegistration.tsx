"use client";

import { useState, useEffect } from "react";
import { useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle } from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";
import { formatInTimeZone } from "date-fns-tz";
import { getWebinarCapacity } from "@/lib/events/capacity";
import type { TSessionStatus } from "../types";

type ClientWebinarRegistrationProps = {
  webinarPlanId: string; // The WebinarPlan ID (for URL path)
  webinarId?: string; // The actual Webinar instance ID (for eventId query param)
  price: number;
  currency?: string | null;
  nextSessionDate?: Date;
  sessionStatus: TSessionStatus;
  appointment?: {
    slotsOfAppointment?: Array<{ user?: Array<{ id: string }> }>;
  } | null;
  /** Plan default; the instance may override it. */
  maxParticipants?: number;
  /** Per-instance capacity override; null inherits the plan's value. */
  instanceMaxParticipants?: number | null;
  consultantUserId?: string;
};

/** The sidebar card's shell and its constant top block: label, price, session line. */
function RegistrationCard({
  price,
  sessionLine,
  children,
}: Readonly<{
  price: string;
  sessionLine: string;
  children: React.ReactNode;
}>) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
        Registration
      </p>
      <p className="mt-3 text-3xl font-semibold tabular-nums text-foreground">
        {price}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{sessionLine}</p>
      <div className="mt-5 space-y-4">{children}</div>
    </div>
  );
}

export function ClientWebinarRegistration({
  webinarPlanId,
  webinarId,
  price,
  currency: _currency,
  nextSessionDate,
  sessionStatus,
  appointment,
  maxParticipants = 100,
  instanceMaxParticipants,
  consultantUserId,
}: ClientWebinarRegistrationProps) {
  const { data: session } = useSession();
  const { formatPrice } = useCurrency();

  // Defer auth + timezone until after hydration to avoid mismatch
  const [hasMounted, setHasMounted] = useState(false);
  const [userTimeZone, setUserTimeZone] = useState("UTC");
  useEffect(() => {
    setHasMounted(true);
    setUserTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  const isLoggedIn = hasMounted && !!session?.user;
  const userId = session?.user?.id;

  // Check if user is already registered for this webinar
  const isAlreadyRegistered =
    userId &&
    appointment?.slotsOfAppointment?.some((slot) =>
      slot.user?.some((u) => u.id === userId),
    );

  const capacity = getWebinarCapacity({
    webinar: { maxParticipants: instanceMaxParticipants ?? null, appointment },
    plan: { maxParticipants },
    excludeUserIds: consultantUserId ? [consultantUserId] : [],
  });
  const isFull = capacity.isFull;

  const handleRegistration = () => {
    // Only checkout-able when the session is upcoming, a webinar instance
    // exists, and there's still room — a sold-out webinar falls back to the
    // page so the visitor sees the sold-out state rather than a dead checkout.
    const checkoutUrl =
      sessionStatus === "Upcoming" && webinarId && !isFull
        ? `/checkout/plans/webinar/${webinarPlanId}?eventId=${webinarId}`
        : null;
    if (!isLoggedIn) {
      // Preserve the next step as a RELATIVE callbackUrl (the sign-in page drops
      // absolute URLs) — checkout when registerable, else this page — so a
      // first-timer lands there after auth + onboarding.
      const returnTo =
        checkoutUrl ?? window.location.pathname + window.location.search;
      window.location.href = `/auth/signin?callbackUrl=${encodeURIComponent(returnTo)}`;
      return;
    }
    if (checkoutUrl) {
      window.location.href = checkoutUrl;
    }
  };

  let sessionInfoText: string;
  if (nextSessionDate) {
    const formattedDate = formatInTimeZone(
      new Date(nextSessionDate),
      userTimeZone,
      "MMMM d, yyyy 'at' h:mm a zzz",
    );
    if (sessionStatus === "Completed") {
      sessionInfoText = `Session ended ${formattedDate}`;
    } else if (sessionStatus === "Happening Now") {
      sessionInfoText = `Session started ${formattedDate}`;
    } else if (sessionStatus === "Upcoming") {
      sessionInfoText = `Next session ${formattedDate}`;
    } else {
      // "To be announced" but has a nextSessionDate (edge case) or other unhandled status
      sessionInfoText = `Scheduled ${formattedDate}`;
    }
  } else if (sessionStatus === "Completed") {
    sessionInfoText = "This webinar has ended.";
  } else if (sessionStatus === "Happening Now") {
    sessionInfoText = "This webinar is in progress.";
  } else {
    // Fallback for !nextSessionDate and status is "Upcoming" or "To be announced"
    sessionInfoText = "Session time to be announced.";
  }

  const priceLabel = formatPrice(price);

  // Logic for buttonText and buttonDisabled
  let buttonText = `Pay ${priceLabel} and register`;
  let buttonDisabled = false;

  if (sessionStatus === "Completed") {
    buttonText = "Session ended";
    buttonDisabled = true;
  } else if (sessionStatus === "Happening Now") {
    buttonText = "Session in progress";
    buttonDisabled = true;
  } else if (sessionStatus === "To be announced" || !webinarId) {
    // Disable registration when no session is scheduled or no webinar instance exists
    buttonText = "Registration opening soon";
    buttonDisabled = true;
  }

  const soldOutBadge = (
    <Badge variant="secondary">Sold out · all {capacity.max} seats taken</Badge>
  );

  if (!isLoggedIn) {
    // For non-logged in users, the button primarily serves to redirect to sign-in.
    // We can still reflect the session status in the button text and disable it if not upcoming.
    let signInButtonText = "Sign in to register";
    let signInButtonDisabled = false;

    if (sessionStatus === "Completed") {
      signInButtonText = "Session ended";
      signInButtonDisabled = true;
    } else if (sessionStatus === "Happening Now") {
      signInButtonText = "Session in progress";
      signInButtonDisabled = true;
    } else if (sessionStatus === "To be announced" || !webinarId) {
      signInButtonText = "Registration opening soon";
      signInButtonDisabled = true;
    } else if (isFull) {
      // Sending a signed-out visitor through sign-in only to meet a sold-out
      // card is a wasted round trip; say so up front.
      signInButtonText = "Sold out";
      signInButtonDisabled = true;
    }

    return (
      <RegistrationCard price={priceLabel} sessionLine={sessionInfoText}>
        {isFull && soldOutBadge}
        {!signInButtonDisabled && (
          <p className="text-sm text-muted-foreground">
            Sign in to reserve your seat.
          </p>
        )}
        <Button
          onClick={handleRegistration} // This redirects to sign-in
          className="h-11 w-full rounded-xl"
          disabled={signInButtonDisabled}
        >
          {signInButtonText}
        </Button>
      </RegistrationCard>
    );
  }

  // Show "Already Registered" state for logged-in users who are already registered
  if (isAlreadyRegistered) {
    return (
      <RegistrationCard price={priceLabel} sessionLine={sessionInfoText}>
        <Badge variant="success" className="gap-1.5">
          <CheckCircle className="h-3.5 w-3.5" />
          Registered
        </Badge>
        <p className="text-sm text-muted-foreground">
          Check your email for the webinar details and join link.
        </p>
      </RegistrationCard>
    );
  }

  // Sold out — registration is simply closed. The host can reopen it by
  // raising the capacity on this webinar.
  if (isFull && isLoggedIn && !isAlreadyRegistered) {
    return (
      <RegistrationCard price={priceLabel} sessionLine={sessionInfoText}>
        {soldOutBadge}
        <p className="text-sm text-muted-foreground">
          Registration for this session is closed. Check back in case the host
          opens more seats, or browse the other sessions on this plan.
        </p>
        <Button className="h-11 w-full rounded-xl" disabled>
          Sold out
        </Button>
      </RegistrationCard>
    );
  }

  return (
    <RegistrationCard price={priceLabel} sessionLine={sessionInfoText}>
      <Button
        onClick={handleRegistration}
        className="h-11 w-full rounded-xl"
        disabled={buttonDisabled}
      >
        {buttonText}
      </Button>
    </RegistrationCard>
  );
}
