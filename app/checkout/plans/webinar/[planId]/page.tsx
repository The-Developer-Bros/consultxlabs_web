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
  createCheckoutData,
  WebinarSearchParams,
  webinarSearchParamsSchema,
  type SupportedCheckoutGateway,
} from "@/schemas/checkout";
import { CreditCard as CreditCardIcon } from "lucide-react";
import { CompanyLogo } from "@/components/ui/company-logo";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import RazorpayCheckout from "../../../components/RazorpayCheckout";
import StripeCheckout from "../../../components/StripeCheckout";
import {
  createHandleApiError,
  createHandleCheckoutSuccess,
  createRazorpayCheckoutHandlers,
  createStripeCheckoutHandlers,
  handleUnifiedCheckout,
  paymentGateways,
  reportPaymentsError,
} from "../../utils";
import { calculatePricing, formatPercentage } from "../../math";
import { getWebinarCapacity } from "@/lib/events/capacity";
import { useCurrency } from "@/hooks/useCurrency";
import { useCheckoutTaxContext } from "../../useCheckoutTaxContext";
import type { AppliedDiscount } from "@/types/checkout";
import { OrgPayerSelector } from "@/app/checkout/components/OrgPayerSelector";
import { FxEstimateNote } from "@/app/checkout/components/FxEstimateNote";
import {
  BillingStateSelect,
  useBillingState,
} from "@/app/checkout/components/BillingStateSelect";

import type {
  Appointment,
  ConsultantProfile,
  ConsultantReview,
  Domain,
  Tag as PrismaTag,
  Topic as PrismaTopic,
  Webinar as PrismaWebinar,
  SlotOfAppointment,
  SubDomain,
  User,
  WebinarPlan,
} from "@prisma/client";

// Define a type for the fetched WebinarPlan data.
// price arrives as number: extended client + JSON serialization (#780)
export type CheckoutWebinarPlanData = Omit<WebinarPlan, "price"> & {
  price: number;
  consultantProfile:
    | (ConsultantProfile & {
        user: User & {
          workExperiences?: Array<{
            company: string;
            companyDomain: string | null;
            isCurrent: boolean;
          }>;
        };
        domain: Domain | null;
        subDomains: SubDomain[];
        tags: PrismaTag[];
      })
    | null;
  webinars: (PrismaWebinar & {
    appointment:
      | (Appointment & {
          // `user` is what makes a seat count a seat — `fetchWebinarPlanDetail`
          // has always included it, the type simply never said so, and
          // `countWebinarParticipants` answers 0 in silence when it is absent.
          slotsOfAppointment: (SlotOfAppointment & {
            user: { id: string }[];
          })[];
        })
      | null;
  })[];
  topics: PrismaTopic[];
  type: "webinar";
  imageUrl: string;
};

type PlanResponse = {
  data: CheckoutWebinarPlanData;
};

type PageProps = {
  params: Promise<{ planId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function WebinarCheckoutPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  // Next.js 15 Synchronous params and searchParams
  const resolvedParams = use(params);
  const resolvedSearchParams = use(searchParams);

  const { formatPrice, currency } = useCurrency();
  const checkoutTaxContext = useCheckoutTaxContext();
  const [planData, setPlanData] = useState<PlanResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [_reviews, _setReviews] = useState<ConsultantReview[]>([]);
  const [isCheckoutProcessing, setIsCheckoutProcessing] = useState(false);
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
  const [availableCredits, setAvailableCredits] = useState(0);
  const [isLoadingCredits, setIsLoadingCredits] = useState(true);

  const { toast } = useToast();
  const {
    isBlocked: isMaintenanceBlocked,
    blockReason: maintenanceBlockReason,
  } = useMaintenanceGuard();

  // Validate search params once with Zod — single source of truth for all checkout flows
  const validatedSearchParams = useMemo((): WebinarSearchParams | null => {
    const result = webinarSearchParamsSchema.safeParse(resolvedSearchParams);
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
          amount: planData?.data?.price || 0,
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

  // Create utility functions using the toast instance
  const handleApiError = useMemo(() => createHandleApiError(toast), [toast]);
  const handleCheckoutSuccess = useMemo(
    () => createHandleCheckoutSuccess(toast, "WEBINAR"),
    [toast],
  );
  const stripeHandlers = createStripeCheckoutHandlers(toast);
  const razorpayHandlers = createRazorpayCheckoutHandlers(toast);

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

        // Use pre-validated search params
        if (!validatedSearchParams) {
          throw new Error("Invalid webinar parameters");
        }

        if (!planData?.data?.id) {
          throw new Error("Webinar plan not found");
        }

        // Staleness check: validate the target webinar is still available
        const targetWebinar = planData.data.webinars?.find(
          (w) => w.id === validatedSearchParams.eventId,
        );
        if (!targetWebinar) {
          throw new Error("Webinar session not found.");
        }
        if (targetWebinar.status === "COMPLETED") {
          throw new Error("This webinar has already ended.");
        }
        if (targetWebinar.status === "CANCELLED") {
          throw new Error("This webinar has been cancelled.");
        }
        // Seats can go while this tab sits open. The server holds the real
        // gate under the allocation lock; this stops the buyer paying into a
        // rejection.
        if (
          getWebinarCapacity({
            webinar: targetWebinar,
            plan: { maxParticipants: planData.data.maxParticipants },
            excludeUserIds: planData.data.consultantProfile?.user?.id
              ? [planData.data.consultantProfile.user.id]
              : [],
          }).isFull
        ) {
          throw new Error("This webinar is now full.");
        }

        const checkoutData = createCheckoutData({
          appointmentType: "WEBINAR",
          planId: planData.data.id,
          eventId: validatedSearchParams.eventId,
          discountCode: appliedDiscount?.code,
          paymentGateway: gateway,
          displayCurrency: currency,
          useReferralCredits: selectedOrganizationId
            ? false
            : useReferralCredits,
          organizationId: selectedOrganizationId ?? undefined,
          ...billingState.bodyField,
        });

        // Handle unified checkout flow using the utility
        await handleUnifiedCheckout(
          checkoutData,
          gateway,
          handleApiError,
          handleCheckoutSuccess,
          isMockPayment,
        );
      } catch (error) {
        reportPaymentsError(error);
        console.error("Checkout error:", error);
        if (error instanceof Error) {
          // Provide more informative error messages based on the error type
          let errorTitle = "Unable to Complete Registration";
          let errorDescription = error.message;

          if (error.message.includes("Invalid webinar parameters")) {
            errorTitle = "Registration Link Error";
            errorDescription =
              "The registration information is incomplete. Please go back to the webinar page and click 'Register Now' again to ensure all required information is included.";
          } else if (error.message.includes("Webinar plan not found")) {
            errorTitle = "Webinar Not Found";
            errorDescription =
              "This webinar could not be found or may no longer be available. Please go back and select a different webinar, or contact support if you believe this is an error.";
          } else if (
            error.message.includes("network") ||
            error.message.includes("fetch")
          ) {
            errorTitle = "Connection Error";
            errorDescription =
              "Unable to connect to the server. Please check your internet connection and try again.";
          } else {
            errorDescription = `${error.message}. Please try again or contact support if the problem persists.`;
          }

          toast({
            title: errorTitle,
            description: errorDescription,
            variant: "destructive",
          });
        }
      } finally {
        isProcessingRef.current = false;
        setIsCheckoutProcessing(false);
        setProcessingGateway(null);
      }
    },
    [
      isCheckoutProcessing,
      isMaintenanceBlocked,
      maintenanceBlockReason,
      planData?.data?.id,
      planData?.data?.webinars,
      planData?.data?.maxParticipants,
      planData?.data?.consultantProfile?.user?.id,
      handleApiError,
      handleCheckoutSuccess,
      toast,
      appliedDiscount,
      useReferralCredits,
      selectedOrganizationId,
      billingState.bodyField,
      validatedSearchParams,
      currency,
    ],
  );

  /**
   * Re-check the seat count against the click, not the last render.
   *
   * The gate above lives inside `handleCheckout`, whose only production caller
   * is the development mock-pay button — the real Razorpay and Stripe controls
   * take `checkoutData` and open the gateway themselves. So the soft gate was
   * inert exactly where money moves: a webinar that filled while this tab sat
   * open still let the buyer pay into a rejection.
   *
   * `no-store` because the plan endpoint is cached `s-maxage=60`, and a
   * minute-old seat count is the thing being corrected. Refreshing `planData`
   * also re-derives `isSoldOut`, so both gateway buttons disable behind this.
   *
   * A failed check does NOT block the sale: the allocation lock on the server
   * is the authority, and refusing a paying customer because a display query
   * timed out trades a real sale for a race we do not own.
   */
  const revalidateSeatsBeforePayment = useCallback(async () => {
    if (!validatedSearchParams?.eventId) return true;
    try {
      const response = await fetch(
        `/api/plans/webinars/${resolvedParams.planId}`,
        { cache: "no-store" },
      );
      if (!response.ok) return true;
      const fresh: PlanResponse = await response.json();
      const freshWebinar = fresh.data?.webinars?.find(
        (w) => w.id === validatedSearchParams.eventId,
      );
      if (!fresh.data || !freshWebinar) return true;

      setPlanData(fresh);

      if (
        getWebinarCapacity({
          webinar: freshWebinar,
          plan: { maxParticipants: fresh.data.maxParticipants },
          excludeUserIds: fresh.data.consultantProfile?.user?.id
            ? [fresh.data.consultantProfile.user.id]
            : [],
        }).isFull
      ) {
        toast({
          title: "This webinar is now full",
          description:
            "The last seat went while this page was open, so we stopped the payment before you were charged.",
          variant: "destructive",
        });
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }, [resolvedParams.planId, validatedSearchParams?.eventId, toast]);

  useEffect(() => {
    async function fetchPlanData() {
      setIsLoading(true);
      try {
        const endpoint = `/api/plans/webinars/${resolvedParams.planId}`;

        const response = await fetch(endpoint);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (!data.data?.consultantProfile?.user) {
          throw new Error("Consultant details not found");
        }

        setPlanData(data);

        // Fetch reviews for the consultant
        const reviewsData = await fetchReviews(
          data.data.consultantProfile?.id ?? "",
        );
        _setReviews(reviewsData);
      } catch (error) {
        reportPaymentsError(error);
        console.error("Error fetching plan data:", error);
        setError(
          error instanceof Error
            ? error.message
            : "An unexpected error occurred. Please try again.",
        );
      } finally {
        setIsLoading(false);
      }
    }

    fetchPlanData();
  }, [resolvedParams.planId]);

  // Calculate pricing using the proper math functions
  // NOTE: This must be before early returns to maintain consistent hook order
  const pricing = useMemo(() => {
    const basePrice = planData?.data?.price || 0;
    let discountPercent = 0;
    let discountAmount = 0;
    if (appliedDiscount) {
      // Use the pre-calculated discountAmount from API if available
      // This already includes the maxDiscount cap
      if (appliedDiscount.discountAmount !== undefined) {
        discountAmount = appliedDiscount.discountAmount;
      } else if (appliedDiscount.discountType === "PERCENTAGE") {
        discountPercent = appliedDiscount.discountValue / 100;
      } else if (appliedDiscount.discountType === "FIXED_AMOUNT") {
        discountAmount = appliedDiscount.discountValue;
      }
    }
    return calculatePricing(basePrice, {
      discountPercent: discountAmount > 0 ? 0 : discountPercent,
      discountAmount,
      creditsApplied: useReferralCredits ? availableCredits : 0,
      isInternational: checkoutTaxContext.isInternational,
      exportZeroRated: checkoutTaxContext.exportZeroRated,
    });
  }, [
    planData?.data?.price,
    appliedDiscount,
    useReferralCredits,
    availableCredits,
    checkoutTaxContext.isInternational,
    checkoutTaxContext.exportZeroRated,
  ]);

  // Periodic staleness check: detect if webinar has ended or been cancelled
  useEffect(() => {
    if (!planData?.data?.webinars) return;

    const eventId =
      typeof resolvedSearchParams.eventId === "string"
        ? resolvedSearchParams.eventId
        : undefined;

    const checkStaleness = () => {
      const targetWebinar = eventId
        ? planData.data.webinars.find((w) => w.id === eventId)
        : planData.data.webinars[0];

      if (!targetWebinar) return;

      if (targetWebinar.status === "COMPLETED") {
        setError("This webinar has already ended.");
      } else if (targetWebinar.status === "CANCELLED") {
        setError("This webinar has been cancelled.");
      } else if (targetWebinar.appointment?.slotsOfAppointment?.[0]) {
        const firstSlotEnd = new Date(
          targetWebinar.appointment.slotsOfAppointment[
            targetWebinar.appointment.slotsOfAppointment.length - 1
          ].endsAt,
        );
        if (firstSlotEnd.getTime() < Date.now()) {
          setError("This webinar session has already ended. Please go back.");
        }
      }
    };

    checkStaleness();
    const intervalId = setInterval(checkStaleness, 60_000);
    return () => clearInterval(intervalId);
  }, [planData, resolvedSearchParams.eventId]);

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

  const planDetails = planData?.data;
  const consultantDetails = planDetails?.consultantProfile;
  const userDetails = consultantDetails?.user;

  // The instance being bought, not the plan's first one — ?eventId names it.
  const targetWebinar = validatedSearchParams?.eventId
    ? planDetails?.webinars?.find((w) => w.id === validatedSearchParams.eventId)
    : planDetails?.webinars?.[0];

  // Date and time of the session being paid for, for the same reason.
  const nextSession = targetWebinar?.appointment?.slotsOfAppointment?.[0];

  // Seats, honestly. This line used to print the PLAN's maxParticipants, which
  // an instance override silently contradicts, and counted nobody — so a sold
  // out webinar advertised its full capacity and took the money anyway.
  const capacity =
    targetWebinar && planDetails
      ? getWebinarCapacity({
          webinar: targetWebinar,
          plan: { maxParticipants: planDetails.maxParticipants },
          excludeUserIds: userDetails?.id ? [userDetails.id] : [],
        })
      : null;
  const isSoldOut = capacity?.isFull ?? false;

  if (!planData || !planDetails || !consultantDetails || !userDetails) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p>Essential webinar data is missing. Please try again later.</p>
      </div>
    );
  }

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
                {consultantDetails?.headline ||
                  consultantDetails?.domain?.name ||
                  "Consultant"}
              </div>
              {userDetails?.workExperiences &&
                userDetails.workExperiences.length > 0 && (
                  <div className="flex items-center gap-1.5 mt-1">
                    {userDetails.workExperiences.slice(0, 3).map((exp, i) => (
                      <CompanyLogo
                        key={`checkout-webinar-company-${i}`}
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
            <div className="font-semibold">Webinar</div>
            <div className="text-sm text-muted-foreground truncate">
              {planDetails?.title || "Online Session"}
            </div>
          </div>
        </div>
        <Separator className="bg-border" />
        <div className="grid gap-2">
          <div className="font-semibold">Webinar Details</div>
          <div className="grid gap-2">
            {nextSession && (
              <>
                <div className="flex items-center justify-between">
                  <div className="text-muted-foreground">Date</div>
                  <div>
                    {new Date(nextSession.startsAt).toLocaleDateString(
                      undefined,
                      {
                        weekday: "long",
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      },
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="text-muted-foreground">Time</div>
                  <div>
                    {new Date(nextSession.startsAt).toLocaleTimeString()} -{" "}
                    {new Date(nextSession.endsAt).toLocaleTimeString()} (
                    {Intl.DateTimeFormat().resolvedOptions().timeZone})
                  </div>
                </div>
              </>
            )}
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Duration</div>
              <div>{planDetails?.durationInHours || 1} hours</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Seats left</div>
              <div className={isSoldOut ? "font-medium text-red-600" : ""}>
                {capacity
                  ? isSoldOut
                    ? "Sold out"
                    : `${capacity.remaining} of ${capacity.max}`
                  : (planDetails?.maxParticipants ?? "—")}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Language</div>
              <div>{planDetails?.language || "English"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Level</div>
              <div>{planDetails?.level || "All Levels"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Prerequisites</div>
              <div>{planDetails?.prerequisites || "None"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Material Provided</div>
              <div>{planDetails?.materialProvided || "None"}</div>
            </div>
          </div>
        </div>
        <Separator className="bg-border" />
        <OrgPayerSelector
          selectedOrganizationId={selectedOrganizationId}
          planType="WEBINAR"
          planId={resolvedParams.planId}
          onSelect={(id) => {
            setSelectedOrganizationId(id);
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
              onChange={(e) => setDiscountCodeInput(e.target.value)}
              disabled={isApplyingDiscount || !!appliedDiscount}
            />
            <Button
              variant="outline"
              onClick={() => handleApplyDiscount()}
              disabled={isApplyingDiscount || !!appliedDiscount}
            >
              {isApplyingDiscount ? "Applying..." : "Apply"}
            </Button>
          </div>
          {discountError && (
            <div className="text-sm text-red-500">{discountError}</div>
          )}
          {appliedDiscount && (
            <div className="flex items-center justify-between gap-3 bg-green-50 p-3 rounded-md">
              <div className="min-w-0">
                <div className="font-medium text-green-700 truncate">
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
                className="shrink-0"
                onClick={() => {
                  setAppliedDiscount(null);
                  setDiscountError(null);
                }}
              >
                Remove
              </Button>
            </div>
          )}
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium">WEBINAR10</div>
                <div className="text-sm text-muted-foreground">
                  Get 10% off your webinar registration
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div className="text-muted-foreground">10% off</div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleApplyDiscount("WEBINAR10")}
                  disabled={isApplyingDiscount || !!appliedDiscount}
                >
                  Apply
                </Button>
              </div>
            </div>
          </div>
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
            <CardTitle className="text-foreground">Webinar Pricing</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Registration Fee</div>
                <div>{formatPrice(planDetails?.price || 0)}</div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <span className="font-semibold">Includes</span>
                </div>
                <div className="font-semibold">
                  <ul className="list-disc">
                    <li>Live webinar access</li>
                    <li>Q&A session</li>
                    <li>Recording access</li>
                    <li>Certificate of attendance</li>
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
                <div>{formatPrice(pricing.total)}</div>
              </div>
              <FxEstimateNote
                totalPaise={pricing.total}
                organizationId={selectedOrganizationId}
              />
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
                  {isSoldOut ? (
                    <Button variant="outline" disabled>
                      Sold out
                    </Button>
                  ) : gateway.isActive ? (
                    <div className="flex gap-2">
                      {validatedSearchParams &&
                      gateway.gateway === "RAZORPAY" ? (
                        <RazorpayCheckout
                          checkoutData={createCheckoutData({
                            appointmentType: "WEBINAR",
                            planId: planDetails.id,
                            eventId: validatedSearchParams.eventId,
                            paymentGateway: "RAZORPAY",
                            discountCode: appliedDiscount?.code,
                            displayCurrency: currency,
                            useReferralCredits: selectedOrganizationId
                              ? false
                              : useReferralCredits,
                            organizationId: selectedOrganizationId ?? undefined,
                            ...billingState.bodyField,
                          })}
                          onPaymentSuccess={razorpayHandlers.onPaymentSuccess}
                          onPaymentError={razorpayHandlers.onPaymentError}
                          onBeforeCheckout={revalidateSeatsBeforePayment}
                          disabled={isMaintenanceBlocked || isSoldOut}
                        />
                      ) : validatedSearchParams &&
                        gateway.gateway === "STRIPE" ? (
                        <StripeCheckout
                          checkoutData={createCheckoutData({
                            appointmentType: "WEBINAR",
                            planId: planDetails.id,
                            eventId: validatedSearchParams.eventId,
                            paymentGateway: "STRIPE",
                            discountCode: appliedDiscount?.code,
                            displayCurrency: currency,
                            useReferralCredits: selectedOrganizationId
                              ? false
                              : useReferralCredits,
                            organizationId: selectedOrganizationId ?? undefined,
                            ...billingState.bodyField,
                          })}
                          onPaymentSuccess={stripeHandlers.onPaymentSuccess}
                          onPaymentError={stripeHandlers.onPaymentError}
                          onBeforeCheckout={revalidateSeatsBeforePayment}
                          disabled={isMaintenanceBlocked || isSoldOut}
                        />
                      ) : null}
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
