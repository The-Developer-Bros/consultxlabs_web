"use client";

import { useState, useEffect } from "react";
import { useSession } from "@/lib/auth-client";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
      sessionInfoText = `Session ended: ${formattedDate}`;
    } else if (sessionStatus === "Happening Now") {
      sessionInfoText = `Session started: ${formattedDate}`;
    } else if (sessionStatus === "Upcoming") {
      sessionInfoText = `Next session: ${formattedDate}`;
    } else {
      // "To be announced" but has a nextSessionDate (edge case) or other unhandled status
      sessionInfoText = `Scheduled: ${formattedDate}`;
    }
  } else if (sessionStatus === "Completed") {
    sessionInfoText = "This webinar has ended.";
  } else if (sessionStatus === "Happening Now") {
    sessionInfoText = "This webinar is currently in progress.";
  } else {
    // Fallback for !nextSessionDate and status is "Upcoming" or "To be announced"
    sessionInfoText = "Session time to be announced.";
  }

  // Logic for buttonText and buttonDisabled
  let buttonText = `Pay ${formatPrice(price)} & Register Now`;
  let buttonDisabled = false;

  if (sessionStatus === "Completed") {
    buttonText = "Session Ended";
    buttonDisabled = true;
  } else if (sessionStatus === "Happening Now") {
    buttonText = "Session in Progress";
    buttonDisabled = true;
  } else if (sessionStatus === "To be announced" || !webinarId) {
    // Disable registration when no session is scheduled or no webinar instance exists
    buttonText = "Registration Opening Soon";
    buttonDisabled = true;
  }

  if (!isLoggedIn) {
    // For non-logged in users, the button primarily serves to redirect to sign-in.
    // We can still reflect the session status in the button text and disable it if not upcoming.
    let signInButtonText = "Sign in to Register";
    let signInButtonDisabled = false;

    if (sessionStatus === "Completed") {
      signInButtonText = "Session Ended";
      signInButtonDisabled = true;
    } else if (sessionStatus === "Happening Now") {
      signInButtonText = "Session in Progress";
      signInButtonDisabled = true;
    } else if (sessionStatus === "To be announced" || !webinarId) {
      signInButtonText = "Registration Opening Soon";
      signInButtonDisabled = true;
    } else if (isFull) {
      // Sending a signed-out visitor through sign-in only to meet a sold-out
      // card is a wasted round trip; say so up front.
      signInButtonText = "Sold out";
      signInButtonDisabled = true;
    }

    return (
      <Card>
        <CardHeader>
          <CardTitle>Webinar Registration</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground mb-4">
            {sessionInfoText} {/* Show current session status info */}
          </p>
          {isFull && (
            <Badge
              variant="secondary"
              className="mb-4 bg-amber-100 text-amber-800"
            >
              Sold out — all {capacity.max} seats taken
            </Badge>
          )}
          {!signInButtonDisabled && (
            <p className="text-muted-foreground mb-4">
              Please sign in to register for this webinar.
            </p>
          )}
          <Button
            onClick={handleRegistration} // This redirects to sign-in
            className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
            disabled={signInButtonDisabled}
          >
            {signInButtonText}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Show "Already Registered" state for logged-in users who are already registered
  if (isAlreadyRegistered) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Webinar Registration</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 mb-4">
            <CheckCircle className="h-5 w-5 text-green-600" />
            <Badge className="bg-green-100 text-green-800 border-green-300">
              Already Registered
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            {sessionInfoText}
          </p>
          <p className="text-sm text-muted-foreground">
            Check your email for webinar details and join link.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Sold out — registration is simply closed. The host can reopen it by
  // raising the capacity on this webinar.
  if (isFull && isLoggedIn && !isAlreadyRegistered) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Webinar Registration</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            {sessionInfoText}
          </p>
          <Badge
            variant="secondary"
            className="mb-4 bg-amber-100 text-amber-800"
          >
            Sold out — all {capacity.max} seats taken
          </Badge>
          <p className="text-sm text-muted-foreground">
            Registration for this session is closed. Check back in case the host
            opens more seats, or browse the other sessions on this plan.
          </p>
        </CardContent>
        <CardFooter>
          <Button className="w-full" disabled>
            Sold out
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Webinar Registration</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground mb-4">{sessionInfoText}</p>
      </CardContent>
      <CardFooter>
        <Button
          onClick={handleRegistration}
          className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
          disabled={buttonDisabled}
        >
          {buttonText}
        </Button>
      </CardFooter>
    </Card>
  );
}
