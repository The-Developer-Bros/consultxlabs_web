"use client";

import { useState, useEffect } from "react";
import { useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle } from "lucide-react";
import { ClassPlanProgram } from "@/lib/explore/programs";
import { isUserEnrolled } from "@/lib/payments/utils/participants";
import { useCurrency } from "@/hooks/useCurrency";
import { formatInTimeZone } from "date-fns-tz";
import { getClassCapacity } from "@/lib/events/capacity";

type ClientClassRegistrationProps = {
  readonly plan: ClassPlanProgram;
  maxParticipants?: number;
  consultantUserId?: string;
};

/** The sidebar card's shell and its constant top block: label, price, start date. */
function RegistrationCard({
  price,
  startLine,
  children,
}: Readonly<{
  price: string;
  startLine: string;
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
      <p className="mt-1 text-sm text-muted-foreground">{startLine}</p>
      <div className="mt-5 space-y-4">{children}</div>
    </div>
  );
}

export function ClientClassRegistration({
  plan,
  maxParticipants,
  consultantUserId,
}: ClientClassRegistrationProps) {
  const { id: classId, price, classes } = plan;
  const startDate = classes?.[0]?.schedulingPeriodStartsAt;
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

  // Check if user is already enrolled in this class
  const appointments = classes?.flatMap((c) => c.appointments ?? []) ?? [];
  const isAlreadyEnrolled = userId
    ? isUserEnrolled(appointments, userId)
    : false;

  // Capacity comes from the class instance when it sets one, else the plan.
  const capacity = getClassCapacity({
    classInstance: {
      maxParticipants: classes?.[0]?.maxParticipants ?? null,
      appointments,
    },
    plan: { maxParticipants: maxParticipants ?? plan.maxParticipants ?? 100 },
    excludeUserIds: consultantUserId ? [consultantUserId] : [],
  });
  const isFull = capacity.isFull;

  const handleRegistration = () => {
    const checkoutUrl = `/checkout/plans/class/${classId}`;
    if (!isLoggedIn) {
      // Preserve the checkout destination as a RELATIVE callbackUrl (the sign-in
      // page drops absolute URLs) so a first-timer lands on checkout after auth +
      // onboarding.
      window.location.href = `/auth/signin?callbackUrl=${encodeURIComponent(checkoutUrl)}`;
      return;
    }
    window.location.href = checkoutUrl;
  };

  const priceLabel = formatPrice(price);
  const startLine = startDate
    ? `Starts ${formatInTimeZone(new Date(startDate), userTimeZone, "MMMM d, yyyy 'at' h:mm a zzz")}`
    : "Start date to be announced";
  const soldOutBadge = (
    <Badge variant="secondary">Sold out · all {capacity.max} seats taken</Badge>
  );

  if (!isLoggedIn) {
    // Determine button state for non-logged in users
    const signInButtonText = isFull ? "Sold out" : "Sign in to register";
    const signInButtonDisabled = isFull;

    return (
      <RegistrationCard price={priceLabel} startLine={startLine}>
        {isFull ? (
          soldOutBadge
        ) : (
          <p className="text-sm text-muted-foreground">
            Sign in to reserve your seat.
          </p>
        )}
        <Button
          onClick={handleRegistration}
          className="h-11 w-full rounded-xl"
          disabled={signInButtonDisabled}
        >
          {signInButtonText}
        </Button>
      </RegistrationCard>
    );
  }

  // Show "Already Enrolled" state for logged-in users who are already enrolled
  if (isAlreadyEnrolled) {
    return (
      <RegistrationCard price={priceLabel} startLine={startLine}>
        <Badge variant="success" className="gap-1.5">
          <CheckCircle className="h-3.5 w-3.5" />
          Enrolled
        </Badge>
        <p className="text-sm text-muted-foreground">
          You are enrolled in this class. Session details are on your dashboard.
        </p>
      </RegistrationCard>
    );
  }

  // Sold out — enrollment is closed until the host opens more seats.
  if (isFull && isLoggedIn && !isAlreadyEnrolled) {
    return (
      <RegistrationCard price={priceLabel} startLine={startLine}>
        {soldOutBadge}
        <p className="text-sm text-muted-foreground">
          Enrollment for this class is closed. Check back in case the instructor
          opens more seats.
        </p>
        <Button className="h-11 w-full rounded-xl" disabled>
          Sold out
        </Button>
      </RegistrationCard>
    );
  }

  return (
    <RegistrationCard price={priceLabel} startLine={startLine}>
      <Button onClick={handleRegistration} className="h-11 w-full rounded-xl">
        Pay {priceLabel} and register
      </Button>
    </RegistrationCard>
  );
}
