"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useMaintenanceGuard } from "@/hooks/useMaintenanceGuard";
import { useToast } from "@/hooks/use-toast";
import { CheckoutPlanSkeleton } from "@/app/checkout/CheckoutSkeletons";
import { fetchReviews } from "@/lib/user";
import {
  CheckoutInput,
  ConsultationSearchParams,
  checkoutResponseSchema,
  consultationSearchParamsSchema,
  createCheckoutData,
  type SupportedCheckoutGateway,
} from "@/schemas/checkout";
import {
  MINIMUM_BOOKING_LEAD_TIME_MS,
  MINIMUM_BOOKING_LEAD_TIME_MINUTES,
} from "@/lib/payments/constants";
import type { AppliedDiscount } from "@/types/checkout";
import { OrgPayerSelector } from "@/app/checkout/components/OrgPayerSelector";
import { FxEstimateNote } from "@/app/checkout/components/FxEstimateNote";
import {
  BillingStateSelect,
  useBillingState,
} from "@/app/checkout/components/BillingStateSelect";
import { useSession } from "@/lib/auth-client";
import {
  ConsultantProfile,
  ConsultantReview,
  ConsultationPlan,
} from "@prisma/client";
import { CreditCard as CreditCardIcon } from "lucide-react";
import { CompanyLogo } from "@/components/ui/company-logo";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import RazorpayCheckout from "../../../components/RazorpayCheckout";
import StripeCheckout from "../../../components/StripeCheckout";
import { createHandleApiError, paymentGateways } from "../../utils";
import { calculatePricing, formatPercentage } from "../../math";
import { useCurrency } from "@/hooks/useCurrency";
import { useCheckoutTaxContext } from "../../useCheckoutTaxContext";
import {
  mintClientIdempotencyKey,
  busyRetryToast,
  fetchCheckoutWithBusyRetry,
  reportPaymentsError,
} from "@/app/checkout/plans/utils";

// price arrives as number: extended client + JSON serialization (#780)
type ConsultationPlanWithConsultant = Omit<ConsultationPlan, "price"> & {
  price: number;
  consultantProfile: ConsultantProfile & {
    user: {
      id: string;
      name: string;
      email: string;
      image: string;
      workExperiences?: Array<{
        company: string;
        companyDomain: string | null;
        isCurrent: boolean;
      }>;
    };
  };
};

type ConsultationResponse = {
  data: ConsultationPlanWithConsultant;
};

type PageProps = {
  params: Promise<{ planId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

// #1414 — lifted out of handleCheckout, which SonarCloud measured at
// cognitive complexity 17 against a ceiling of 15. This branch reads which of
// the three gatewayless confirmations happened; it needs nothing from the
// component's scope.
function gatewaylessConfirmationText(data: {
  isZeroAmountPayment?: boolean;
  isMockPayment?: boolean;
}): string {
  if (data.isZeroAmountPayment) {
    return "Payment completed via referral credits. Your consultation has been confirmed.";
  }
  if (data.isMockPayment) {
    return "Mock payment processed. Your consultation has been confirmed. Check your dashboard for details.";
  }
  return "Your consultation has been confirmed. Check your dashboard for details.";
}

export default function ConsultationCheckoutPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  // Next.js 15 Synchronous params and searchParams
  const resolvedParams = use(params);
  const resolvedSearchParams = use(searchParams);

  const { formatPrice, currency } = useCurrency();
  const checkoutTaxContext = useCheckoutTaxContext();
  const [eventData, setEventData] = useState<ConsultationResponse | null>(null);
  const [_slotData, setSlotData] = useState<Record<string, unknown> | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [_reviews, setReviews] = useState<ConsultantReview[]>([]);
  const [isCheckoutProcessing, setIsCheckoutProcessing] = useState(false);
  // #828 — useState's lazy initializer runs once per mount.
  const [idempotencyKey] = useState(mintClientIdempotencyKey);
  const isProcessingRef = useRef(false);
  const [processingGateway, setProcessingGateway] = useState<string | null>(
    null,
  );
  const [discountCodeInput, setDiscountCodeInput] = useState("");
  const [appliedDiscount, setAppliedDiscount] =
    useState<AppliedDiscount | null>(null);
  const [isApplyingDiscount, setIsApplyingDiscount] = useState(false);
  const [discountError, setDiscountError] = useState<string | null>(null);
  const [useReferralCredits, setUseReferralCredits] = useState(false);
  // #1365 — GST place of supply. Blank is the statutory s.12(2)(b) default, so
  // this never blocks checkout.
  const billingState = useBillingState(checkoutTaxContext.billingStateCode);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<
    string | null
  >(null);
  const { data: session } = useSession();
  const selectedOrgFundingSource = useMemo(() => {
    if (!selectedOrganizationId) return null;
    const memberships = session?.user?.organizationMemberships ?? [];
    return (
      memberships.find((m) => m.organizationId === selectedOrganizationId)
        ?.fundingSource ?? null
    );
  }, [selectedOrganizationId, session?.user?.organizationMemberships]);
  const isLicenseCovered = selectedOrgFundingSource === "LICENSE";
  const [availableCredits, setAvailableCredits] = useState(0);
  const [isLoadingCredits, setIsLoadingCredits] = useState(true);

  const { toast } = useToast();
  const {
    isBlocked: isMaintenanceBlocked,
    blockReason: maintenanceBlockReason,
  } = useMaintenanceGuard();

  // Validate search params once with Zod — single source of truth for all checkout flows
  const validatedSearchParams = useMemo((): ConsultationSearchParams | null => {
    const result =
      consultationSearchParamsSchema.safeParse(resolvedSearchParams);
    return result.success ? result.data : null;
  }, [resolvedSearchParams]);

  // Apply discount code
  const handleApplyDiscount = async (code?: string) => {
    const codeToApply = code || discountCodeInput;
    if (!codeToApply.trim()) {
      setDiscountError("Please enter a discount code");
      return;
    }

    setIsApplyingDiscount(true);
    setDiscountError(null);

    try {
      const response = await fetch("/api/payments/discounts/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: codeToApply,
          amount: eventData?.data?.price || 0,
        }),
      });

      const data = await response.json();

      if (data.valid) {
        setAppliedDiscount({
          code: data.code,
          discountType: data.discountType,
          discountValue: data.discountValue,
          discountAmount: data.discountAmount,
        });
        setDiscountCodeInput("");
        toast({
          title: "Discount Applied",
          description: data.message,
        });
      } else {
        setDiscountError(data.message || "Invalid discount code");
      }
    } catch (_error) {
      setDiscountError("Failed to validate discount code");
    } finally {
      setIsApplyingDiscount(false);
    }
  };

  // Fetch available referral credits
  useEffect(() => {
    async function fetchCredits() {
      try {
        const response = await fetch("/api/referrals/credits/available");
        if (response.ok) {
          const data = await response.json();
          setAvailableCredits(
            data.data.totalAvailable || 0, // already in paise
          );
        }
      } catch (error) {
        reportPaymentsError(error);
        console.error("Error fetching referral credits:", error);
      } finally {
        setIsLoadingCredits(false);
      }
    }
    fetchCredits();
  }, []);

  // Fetch slot details
  useEffect(() => {
    async function fetchSlotData() {
      try {
        const { slotOfAvailabilityWeeklyId, slotOfAvailabilityCustomId } =
          resolvedSearchParams;

        if (slotOfAvailabilityWeeklyId) {
          const response = await fetch(
            `/api/slots/availability/weekly/${slotOfAvailabilityWeeklyId}`,
          );
          if (response.ok) {
            const data = await response.json();
            setSlotData(data.data);
          }
        } else if (slotOfAvailabilityCustomId) {
          const response = await fetch(
            `/api/slots/availability/custom/${slotOfAvailabilityCustomId}`,
          );
          if (response.ok) {
            const data = await response.json();
            setSlotData(data.data);
          }
        }
      } catch (error) {
        console.error("Error fetching slot data:", error);
        toast({
          title: "Warning",
          description:
            "Could not load slot details. You may still proceed with checkout.",
          variant: "default",
        });
      }
    }

    if (
      resolvedSearchParams.slotOfAvailabilityWeeklyId ||
      resolvedSearchParams.slotOfAvailabilityCustomId
    ) {
      fetchSlotData();
    }
  }, [resolvedSearchParams, toast]);

  // Shared error map covers slot-conflict types (AVAILABILITY, LOCK_CONTENTION)
  // so a slot taken mid-checkout shows a clear "pick another time" toast.
  // Matches subscription/class/webinar pages (de-dupes the old inline map).
  const handleApiError = useMemo(() => createHandleApiError(toast), [toast]);

  // Common API request logic
  const makeCheckoutRequest = useCallback(
    async (
      checkoutData: CheckoutInput,
      _gateway: string,
      isMockPayment: boolean = false,
    ) => {
      return fetch("/api/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...checkoutData,
          isMockPayment,
          // #828 — stable per-mount; the server dedupes retries on this key.
          clientIdempotencyKey: idempotencyKey,
        }),
      });
    },
    [idempotencyKey],
  );

  const handleCheckout = useCallback(
    async (
      gateway: SupportedCheckoutGateway,
      isMockPayment: boolean = false,
    ) => {
      // Block checkout during maintenance mode
      if (isMaintenanceBlocked) {
        toast({
          title: "Checkout unavailable",
          description:
            maintenanceBlockReason ?? "Service temporarily unavailable",
          variant: "destructive",
        });
        return;
      }

      // Prevent double-clicks: ref provides synchronous guard (React state is async)
      if (isProcessingRef.current || isCheckoutProcessing) {
        return;
      }
      isProcessingRef.current = true;

      try {
        // Set loading state
        setIsCheckoutProcessing(true);
        setProcessingGateway(`${gateway}-${isMockPayment ? "mock" : "real"}`);

        // Use pre-validated search params (validated once via useMemo)
        if (!validatedSearchParams) {
          throw new Error(
            "Pick a time on the expert's profile — under the plan you want — before checking out.",
          );
        }

        // Create checkout data from validated params
        const checkoutData = createCheckoutData({
          appointmentType: "CONSULTATION",
          planId: resolvedParams.planId,
          paymentGateway: gateway,
          startsAt: validatedSearchParams.startsAt,
          endsAt: validatedSearchParams.endsAt,
          slotOfAvailabilityWeeklyId:
            validatedSearchParams.slotOfAvailabilityWeeklyId,
          slotOfAvailabilityCustomId:
            validatedSearchParams.slotOfAvailabilityCustomId,
          discountCode: appliedDiscount?.code,
          displayCurrency: currency,
          notes: validatedSearchParams.notes,
          useReferralCredits: selectedOrganizationId
            ? false
            : useReferralCredits,
          organizationId: selectedOrganizationId ?? undefined,
          ...billingState.bodyField,
        });

        // Make single API call - backend decides dev vs prod flow
        // B5 — structured BUSY 409s auto-retry once (idempotency key dedupe-safe).
        const response = await fetchCheckoutWithBusyRetry(
          () => makeCheckoutRequest(checkoutData, gateway, isMockPayment),
          (waitSeconds) => toast(busyRetryToast(waitSeconds)),
        );

        if (!response.ok) {
          const errorData = await response.json();
          handleApiError(errorData);
          return; // Toast already shown — don't throw to avoid double toast + console overlay
        }

        const data = await response.json();

        // Validate response using schema
        const validatedResponse = checkoutResponseSchema.safeParse(data);
        if (!validatedResponse.success) {
          throw new Error("Invalid response format from server");
        }

        // Handle application-level errors returned with HTTP 200 (e.g. expired contract, credit limit)
        if (!data.success) {
          handleApiError({ error: data.error, errorType: data.errorType });
          return;
        }

        // handleCheckout is only invoked by the dev-only Mock Pay button (isMockPayment=true).
        // Real payments go through StripeCheckout/RazorpayCheckout components.
        // FIX #520: Also handle zero-amount payments (credits covered full cost)
        if (
          data.skipPayment ||
          data.isMockPayment ||
          data.isZeroAmountPayment
        ) {
          toast({
            title: "✅ Consultation Booked Successfully!",
            description: gatewaylessConfirmationText(data),
            variant: "default",
          });

          setTimeout(() => {
            window.location.href = "/dashboard";
          }, 2000);
        }
      } catch (error) {
        // Only fires for unexpected errors (network failure, JSON parse error, etc.)
        // API errors are handled above with handleApiError() + return
        reportPaymentsError(error);
        toast({
          title: "Checkout Failed",
          description:
            error instanceof Error ? error.message : "Please try again",
          variant: "destructive",
        });
      } finally {
        // Always reset loading state
        isProcessingRef.current = false;
        setIsCheckoutProcessing(false);
        setProcessingGateway(null);
      }
    },
    [
      resolvedParams,
      toast,
      isCheckoutProcessing,
      isMaintenanceBlocked,
      maintenanceBlockReason,
      appliedDiscount,
      useReferralCredits,
      selectedOrganizationId,
      billingState.bodyField,
      validatedSearchParams,
      currency,
      handleApiError,
      makeCheckoutRequest,
    ],
  );

  useEffect(() => {
    async function fetchEventData() {
      setIsLoading(true);
      try {
        // Use pre-validated search params
        if (!validatedSearchParams) {
          throw new Error(
            "Pick a time on the expert's profile — under the plan you want — before checking out.",
          );
        }

        // Staleness check: verify the selected slot hasn't passed or is too soon
        const slotStart = new Date(validatedSearchParams.startsAt);
        const now = new Date();
        if (
          slotStart.getTime() <
          now.getTime() + MINIMUM_BOOKING_LEAD_TIME_MS
        ) {
          throw new Error(
            "The selected time slot is no longer available. It has either passed or starts too soon. Please go back and select a new slot.",
          );
        }

        const endpoint = `/api/plans/consultations/${resolvedParams.planId}`;

        const response = await fetch(endpoint);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (!data.data.consultantProfile?.user) {
          throw new Error("Consultant details not found");
        }

        setEventData(data);

        // Fetch reviews for the consultant
        const reviewsData = await fetchReviews(data.data.consultantProfile.id);
        setReviews(reviewsData);
      } catch (error) {
        reportPaymentsError(error);
        console.error("[Checkout] Error fetching event data:", error);
        setError(
          error instanceof Error
            ? error.message
            : "An unexpected error occurred. Please try again.",
        );
      } finally {
        setIsLoading(false);
      }
    }

    fetchEventData();
  }, [resolvedParams.planId, resolvedSearchParams, validatedSearchParams]);

  // Calculate pricing using the proper math functions
  // NOTE: This must be before early returns to maintain consistent hook order
  const pricing = useMemo(() => {
    const basePrice = eventData?.data?.price || 0;

    // Calculate discount based on applied discount code
    let discountPercent = 0;
    let discountAmount = 0;

    if (appliedDiscount) {
      // Use the pre-calculated discountAmount from API if available
      // This already includes the maxDiscount cap
      if (appliedDiscount.discountAmount !== undefined) {
        discountAmount = appliedDiscount.discountAmount;
      } else if (appliedDiscount.discountType === "PERCENTAGE") {
        discountPercent = appliedDiscount.discountValue / 100; // Convert to decimal
      } else if (appliedDiscount.discountType === "FIXED_AMOUNT") {
        discountAmount = appliedDiscount.discountValue;
      }
    }

    return calculatePricing(basePrice, {
      discountPercent: discountAmount > 0 ? 0 : discountPercent, // Don't use percent if we have a fixed amount
      discountAmount,
      creditsApplied: useReferralCredits ? availableCredits : 0,
      isInternational: checkoutTaxContext.isInternational,
      exportZeroRated: checkoutTaxContext.exportZeroRated,
    });
  }, [
    eventData?.data?.price,
    appliedDiscount,
    useReferralCredits,
    availableCredits,
    checkoutTaxContext.isInternational,
    checkoutTaxContext.exportZeroRated,
  ]);

  // Periodic staleness check: warn user if their slot is about to expire
  useEffect(() => {
    if (!validatedSearchParams) return;

    // Once per crossing, not once per minute. The interval re-fired the same
    // destructive toast every 60s for as long as the tab stayed open, which
    // buried the payment form under a stack of red banners at exactly the
    // moment the buyer was being told to hurry.
    let warned = false;

    const checkStaleness = () => {
      const slotStart = new Date(validatedSearchParams.startsAt);
      const now = new Date();
      const minutesUntilSlot =
        (slotStart.getTime() - now.getTime()) / (60 * 1000);

      if (minutesUntilSlot <= 0) {
        setError(
          "This time slot has passed. Please go back and select a new available slot.",
        );
      } else if (
        minutesUntilSlot <= MINIMUM_BOOKING_LEAD_TIME_MINUTES &&
        !warned
      ) {
        warned = true;
        toast({
          title: "Slot starting soon",
          description: `Your selected slot starts in ${Math.ceil(minutesUntilSlot)} minute${Math.ceil(minutesUntilSlot) === 1 ? "" : "s"}. Please complete checkout quickly or select a later slot.`,
          variant: "destructive",
        });
      }
    };

    checkStaleness();
    const intervalId = setInterval(checkStaleness, 60_000);
    return () => clearInterval(intervalId);
  }, [validatedSearchParams, toast]);

  if (isLoading) {
    return <CheckoutPlanSkeleton />;
  }

  if (error) {
    return (
      <div className="col-span-full flex items-center justify-center min-h-screen bg-muted">
        <div
          className="bg-foreground border border-border text-background p-8 max-w-md w-full mx-4 text-center rounded-xl shadow-xl"
          role="alert"
        >
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-background/10">
            <svg
              className="h-6 w-6 text-background/70"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
              />
            </svg>
          </div>
          <p className="font-semibold text-lg mb-2">Unable to load checkout</p>
          <p className="text-background/70 text-sm">{error}</p>
          <button
            onClick={() => window.history.back()}
            className="mt-5 inline-flex items-center rounded-lg bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
          >
            Go back
          </button>
        </div>
      </div>
    );
  }

  const consultantDetails = eventData?.data.consultantProfile;
  const userDetails = eventData?.data.consultantProfile.user;

  return (
    <>
      <div className="flex flex-col gap-6 border-r border-border bg-gradient-to-br from-muted via-background to-muted p-6 sm:p-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <Avatar className="w-12 h-12 border shrink-0">
              <AvatarImage
                src={userDetails?.image || "/placeholder-user.jpg"}
                alt={userDetails?.name || "Consultant"}
              />
              <AvatarFallback>
                {userDetails?.name ? userDetails.name.charAt(0) : "C"}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="font-semibold truncate">
                {userDetails?.name || "Consultant Name"}
              </div>
              <div className="text-sm text-muted-foreground truncate">
                {consultantDetails?.headline || "Consultant"}
              </div>
              {userDetails?.workExperiences &&
                userDetails.workExperiences.length > 0 && (
                  <div className="flex items-center gap-1.5 mt-1">
                    {userDetails.workExperiences.slice(0, 3).map((exp, i) => (
                      <CompanyLogo
                        key={`checkout-consult-company-${i}`}
                        companyName={exp.company}
                        companyDomain={exp.companyDomain ?? undefined}
                        size={20}
                        className="border-border"
                      />
                    ))}
                  </div>
                )}
            </div>
          </div>
          <div className="text-right min-w-0">
            <div className="font-semibold">Consultation</div>
            <div className="text-sm text-muted-foreground truncate">
              {eventData?.data?.title || "One-on-One Session"}
            </div>
          </div>
        </div>
        <Separator className="bg-border" />
        <div className="grid gap-2">
          <div className="font-semibold">Consultation Details</div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Date</div>
              <div>
                {validatedSearchParams
                  ? new Date(validatedSearchParams.startsAt).toLocaleDateString(
                      undefined,
                      {
                        weekday: "long",
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      },
                    )
                  : "—"}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Time</div>
              <div>
                {validatedSearchParams
                  ? `${new Date(
                      validatedSearchParams.startsAt,
                    ).toLocaleTimeString()} - ${new Date(
                      validatedSearchParams.endsAt,
                    ).toLocaleTimeString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`
                  : "—"}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Duration</div>
              <div>{eventData?.data?.durationInHours || 1} hours</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Language</div>
              <div>{eventData?.data?.language || "English"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Level</div>
              <div>{eventData?.data?.level || "Beginner"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Prerequisites</div>
              <div>{eventData?.data?.prerequisites || "None"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Material Provided</div>
              <div>{eventData?.data?.materialProvided || "None"}</div>
            </div>
          </div>
        </div>
        <Separator className="bg-border" />
        <OrgPayerSelector
          selectedOrganizationId={selectedOrganizationId}
          planType="CONSULTATION"
          planId={resolvedParams.planId}
          onSelect={(id) => {
            setSelectedOrganizationId(id);
            // Disable referral credits when org is selected
            if (id) setUseReferralCredits(false);
          }}
        />
        <Separator className="bg-border" />
        <BillingStateSelect
          value={billingState.value}
          onChange={billingState.onChange}
        />
        <Separator className="bg-border" />
        <div className="grid gap-4">
          <div className="font-semibold">Discount Codes</div>
          <div className="flex items-center gap-2">
            <Input
              type="text"
              placeholder="Enter discount code"
              className="flex-1"
              value={discountCodeInput}
              onChange={(e) =>
                setDiscountCodeInput(e.target.value.toUpperCase())
              }
              disabled={isApplyingDiscount || !!appliedDiscount}
            />
            <Button
              variant="outline"
              onClick={() => handleApplyDiscount()}
              disabled={
                isApplyingDiscount ||
                !!appliedDiscount ||
                !discountCodeInput.trim()
              }
            >
              {isApplyingDiscount ? "Applying..." : "Apply"}
            </Button>
          </div>
          {discountError && (
            <div className="text-sm text-red-500">{discountError}</div>
          )}
          {appliedDiscount && (
            <div className="flex items-center justify-between bg-green-50 p-3 rounded-lg border border-green-200">
              <div>
                <div className="font-medium text-green-700">
                  {appliedDiscount.code}
                </div>
                <div className="text-sm text-green-600">
                  {appliedDiscount.discountType === "PERCENTAGE"
                    ? `${appliedDiscount.discountValue}% off`
                    : `${formatPrice(appliedDiscount.discountValue)} off`}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAppliedDiscount(null);
                  setDiscountError(null);
                }}
                className="text-green-700 hover:text-green-800"
              >
                Remove
              </Button>
            </div>
          )}
        </div>
        <Separator className="bg-border" />
        <div className="grid gap-4">
          <div className="font-semibold">Referral Credits</div>
          {isLoadingCredits ? (
            <div className="text-sm text-muted-foreground">
              Loading credits...
            </div>
          ) : availableCredits > 0 ? (
            <div className="flex items-center justify-between gap-3 bg-muted p-3 rounded-lg border border-border">
              <div className="min-w-0">
                <div className="font-medium text-foreground">
                  {formatPrice(availableCredits)} available
                </div>
                <div className="text-sm text-muted-foreground">
                  Apply to this purchase
                </div>
              </div>
              <Switch
                checked={useReferralCredits}
                onCheckedChange={setUseReferralCredits}
              />
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              No referral credits available
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-8 p-6 sm:p-8 bg-card">
        <Card className="border-border shadow-sm">
          <CardHeader>
            <CardTitle className="text-foreground">
              Consultation Pricing
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Session Fee</div>
                <div>{formatPrice(eventData?.data?.price || 0)}</div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <span className="font-semibold">Includes</span>
                </div>
                <div className="font-semibold">
                  <ul className="list-disc">
                    <li>One-on-one session</li>
                    <li>Personalized guidance</li>
                    <li>Session notes</li>
                    <li>Follow-up resources</li>
                  </ul>
                </div>
              </div>
            </div>
            <Separator className="bg-border" />
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Subtotal</div>
                <div>{formatPrice(pricing.subtotal)}</div>
              </div>
              <div className="flex items-center justify-between">
                <div>Tax ({formatPercentage(pricing.taxRate)})</div>
                <div>{formatPrice(pricing.taxAmount)}</div>
              </div>
              {pricing.discountAmount > 0 && (
                <div className="flex items-center justify-between text-green-600">
                  <div>
                    Discount{" "}
                    {pricing.discountPercent > 0 &&
                      `(${formatPercentage(pricing.discountPercent)})`}
                  </div>
                  <div>-{formatPrice(pricing.discountAmount)}</div>
                </div>
              )}
              {pricing.creditsApplied > 0 && (
                <div className="flex items-center justify-between text-foreground">
                  <div>Referral Credits</div>
                  <div>-{formatPrice(pricing.creditsApplied)}</div>
                </div>
              )}
              <Separator className="bg-border" />
              <div className="flex items-center justify-between font-semibold">
                <div>Total</div>
                <div>
                  {isLicenseCovered
                    ? formatPrice(0)
                    : formatPrice(pricing.total)}
                </div>
              </div>
              {!isLicenseCovered && (
                <FxEstimateNote
                  totalPaise={pricing.total}
                  organizationId={selectedOrganizationId}
                />
              )}
              {isLicenseCovered && (
                <p className="text-xs text-emerald-600">
                  Session value {formatPrice(pricing.total)} — covered by
                  enterprise license
                </p>
              )}
            </div>
          </CardContent>
        </Card>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <div className="font-semibold">Payment</div>
            <div className="text-muted-foreground">
              Select your preferred payment method
            </div>
          </div>
          {paymentGateways.map((gateway) => (
            <Card key={gateway.name} className="border-border">
              <CardHeader>
                <CardTitle className="text-foreground">
                  {gateway.name}
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-4 min-w-0">
                    <CreditCardIcon className="w-8 h-8 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="font-semibold text-foreground">
                        Credit/Debit Card
                      </div>
                      <div className="text-sm text-muted-foreground/70">
                        {gateway.description}
                      </div>
                    </div>
                  </div>
                  {gateway.isActive ? (
                    <div className="flex gap-2">
                      {validatedSearchParams &&
                      gateway.gateway === "RAZORPAY" ? (
                        <RazorpayCheckout
                          checkoutData={createCheckoutData({
                            appointmentType: "CONSULTATION",
                            planId: resolvedParams.planId,
                            paymentGateway: "RAZORPAY",
                            startsAt: validatedSearchParams.startsAt,
                            endsAt: validatedSearchParams.endsAt,
                            slotOfAvailabilityWeeklyId:
                              validatedSearchParams.slotOfAvailabilityWeeklyId,
                            slotOfAvailabilityCustomId:
                              validatedSearchParams.slotOfAvailabilityCustomId,
                            discountCode: appliedDiscount?.code,
                            displayCurrency: currency,
                            notes: validatedSearchParams.notes,
                            useReferralCredits: selectedOrganizationId
                              ? false
                              : useReferralCredits,
                            organizationId: selectedOrganizationId ?? undefined,
                            ...billingState.bodyField,
                          })}
                          onPaymentSuccess={(response: {
                            razorpay_payment_id?: string;
                            message?: string;
                          }) => {
                            toast({
                              title: "Payment Successful",
                              description: `Payment ID: ${response.razorpay_payment_id ?? "N/A"}`,
                            });
                            window.location.href = "/dashboard";
                          }}
                          disabled={isMaintenanceBlocked}
                          onPaymentError={(error: {
                            description?: string;
                            code?: string;
                            reason?: string;
                            message?: string;
                          }) =>
                            handleApiError({
                              error:
                                error.description ??
                                error.message ??
                                error.reason,
                              errorType: error.code,
                            })
                          }
                        />
                      ) : validatedSearchParams &&
                        gateway.gateway === "STRIPE" ? (
                        <StripeCheckout
                          checkoutData={createCheckoutData({
                            appointmentType: "CONSULTATION",
                            planId: resolvedParams.planId,
                            paymentGateway: "STRIPE",
                            startsAt: validatedSearchParams.startsAt,
                            endsAt: validatedSearchParams.endsAt,
                            slotOfAvailabilityWeeklyId:
                              validatedSearchParams.slotOfAvailabilityWeeklyId,
                            slotOfAvailabilityCustomId:
                              validatedSearchParams.slotOfAvailabilityCustomId,
                            discountCode: appliedDiscount?.code,
                            displayCurrency: currency,
                            notes: validatedSearchParams.notes,
                            useReferralCredits: selectedOrganizationId
                              ? false
                              : useReferralCredits,
                            organizationId: selectedOrganizationId ?? undefined,
                            ...billingState.bodyField,
                          })}
                          onPaymentSuccess={(response: {
                            message?: string;
                          }) => {
                            toast({
                              title: "Payment Successful",
                              description:
                                response.message ||
                                "Payment completed successfully",
                            });
                            window.location.href = "/dashboard";
                          }}
                          disabled={isMaintenanceBlocked}
                          onPaymentError={(error: {
                            message?: string;
                            description?: string;
                            errorType?: string;
                          }) =>
                            handleApiError({
                              error: error.message ?? error.description,
                              errorType: error.errorType,
                            })
                          }
                        />
                      ) : null}
                      {/* Mock Payment Button - development only */}
                      {process.env.NODE_ENV === "development" && (
                        <Button
                          variant="secondary"
                          onClick={() => handleCheckout(gateway.gateway, true)}
                          disabled={
                            isCheckoutProcessing || isMaintenanceBlocked
                          }
                        >
                          {isCheckoutProcessing &&
                          processingGateway === `${gateway.gateway}-mock` ? (
                            <>
                              <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-current mr-2"></div>
                              Processing...
                            </>
                          ) : (
                            `Mock Pay (${gateway.name})`
                          )}
                        </Button>
                      )}
                    </div>
                  ) : (
                    <Button variant="outline" disabled>
                      {/* TODO: Implement {gateway.name} integration */}
                      Coming Soon
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </>
  );
}
