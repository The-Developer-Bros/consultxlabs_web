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
  SearchParams,
  searchParamsSchema,
  createCheckoutData,
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
import { useCurrency } from "@/hooks/useCurrency";
import type { AppliedDiscount } from "@/types/checkout";
import { OrgPayerSelector } from "@/app/checkout/components/OrgPayerSelector";
import { FxEstimateNote } from "@/app/checkout/components/FxEstimateNote";
import {
  BillingStateSelect,
  useBillingState,
} from "@/app/checkout/components/BillingStateSelect";
import { useCheckoutTaxContext } from "../../useCheckoutTaxContext";

import type {
  Appointment,
  ClassContent,
  ClassPlan,
  ConsultantProfile,
  ConsultantReview,
  Domain,
  Class as PrismaClass,
  Tag as PrismaTag,
  Topic as PrismaTopic,
  SlotOfAppointment,
  SubDomain,
  User,
} from "@prisma/client";

// price arrives as number: extended client + JSON serialization (#780)
export type CheckoutClassPlanData = Omit<ClassPlan, "price"> & {
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
  classes: (PrismaClass & {
    appointments: (Appointment & {
      slotsOfAppointment: SlotOfAppointment[];
    })[];
  })[];
  topics: PrismaTopic[];
  classContents: ClassContent[];
  type: "class";
  imageUrl: string;
};

type PlanResponse = {
  data: CheckoutClassPlanData;
};

type PageProps = {
  params: Promise<{ planId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function ClassCheckoutPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
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
  const validatedSearchParams = useMemo((): SearchParams | null => {
    const result = searchParamsSchema.safeParse(resolvedSearchParams);
    return result.success ? result.data : null;
  }, [resolvedSearchParams]);

  // Derive the first available class ID — used by both component renders and handleCheckout
  const availableClassId = useMemo(() => {
    const availableClass = planData?.data?.classes?.find(
      (c) => c.status === "SCHEDULED" || c.status === "IN_PROGRESS",
    );
    return availableClass?.id ?? null;
  }, [planData]);

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

  const handleApiError = useMemo(() => createHandleApiError(toast), [toast]);
  const handleCheckoutSuccess = useMemo(
    () => createHandleCheckoutSuccess(toast, "CLASS"),
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

      if (isProcessingRef.current || isCheckoutProcessing) {
        return;
      }
      isProcessingRef.current = true;

      try {
        setIsCheckoutProcessing(true);
        setProcessingGateway(`${gateway}-${isMockPayment ? "mock" : "real"}`);

        if (!validatedSearchParams) {
          throw new Error("Invalid class parameters");
        }

        if (!planData?.data?.id) {
          throw new Error("Class plan not found");
        }

        if (!availableClassId) {
          throw new Error(
            "No available class sessions. All sessions may be full, cancelled, or completed.",
          );
        }

        const checkoutData = createCheckoutData({
          appointmentType: "CLASS",
          planId: planData.data.id,
          eventId: availableClassId,
          discountCode: appliedDiscount?.code,
          displayCurrency: currency,
          paymentGateway: gateway,
          useReferralCredits: selectedOrganizationId
            ? false
            : useReferralCredits,
          organizationId: selectedOrganizationId ?? undefined,
          ...billingState.bodyField,
        });

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
          let errorTitle = "Unable to Complete Enrollment";
          let errorDescription = error.message;

          if (error.message.includes("Invalid class parameters")) {
            errorTitle = "Enrollment Link Error";
            errorDescription =
              "The enrollment information is incomplete. Please go back to the class page and click 'Enroll Now' again to ensure all required information is included.";
          } else if (error.message.includes("Class plan not found")) {
            errorTitle = "Class Not Found";
            errorDescription =
              "This class could not be found or may no longer be available. Please go back and select a different class, or contact support if you believe this is an error.";
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
        setIsCheckoutProcessing(false);
        setProcessingGateway(null);
        isProcessingRef.current = false;
      }
    },
    [
      isCheckoutProcessing,
      isMaintenanceBlocked,
      maintenanceBlockReason,
      resolvedSearchParams,
      planData?.data?.id,
      handleApiError,
      handleCheckoutSuccess,
      toast,
      appliedDiscount,
      useReferralCredits,
      selectedOrganizationId,
      billingState.bodyField,
      validatedSearchParams,
      currency,
      availableClassId,
    ],
  );

  useEffect(() => {
    async function fetchPlanData() {
      setIsLoading(true);
      try {
        const endpoint = `/api/plans/classes/${resolvedParams.planId}`;

        const response = await fetch(endpoint);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (!data.data?.consultantProfile?.user) {
          throw new Error("Consultant details not found");
        }

        setPlanData(data);

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

  // Periodic staleness check: detect if all class sessions have ended or been cancelled
  useEffect(() => {
    if (!planData?.data?.classes) return;

    const checkStaleness = () => {
      const hasAvailable = planData.data.classes.some(
        (c) => c.status === "SCHEDULED" || c.status === "IN_PROGRESS",
      );
      if (!hasAvailable) {
        setError(
          "No available class sessions. All sessions may be full, cancelled, or completed.",
        );
      }
    };

    checkStaleness();
    const intervalId = setInterval(checkStaleness, 60_000);
    return () => clearInterval(intervalId);
  }, [planData]);

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

  const nextClassSession =
    planDetails?.classes?.[0]?.appointments?.[0]?.slotsOfAppointment?.[0];

  if (!planData || !planDetails || !consultantDetails || !userDetails) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p>Essential class data is missing. Please try again later.</p>
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
                        key={`checkout-class-company-${i}`}
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
            <div className="font-semibold">Class</div>
            <div className="text-sm text-muted-foreground truncate">
              {planDetails?.title || "Online Class"}
            </div>
          </div>
        </div>
        <Separator className="bg-border" />
        <div className="grid gap-2">
          <div className="font-semibold">Class Details</div>
          <div className="grid gap-2">
            {nextClassSession && (
              <>
                <div className="flex items-center justify-between">
                  <div className="text-muted-foreground">First Session</div>
                  <div>
                    {new Date(nextClassSession.startsAt).toLocaleDateString(
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
                    {new Date(nextClassSession.startsAt).toLocaleTimeString()} -{" "}
                    {new Date(nextClassSession.endsAt).toLocaleTimeString()} (
                    {Intl.DateTimeFormat().resolvedOptions().timeZone})
                  </div>
                </div>
              </>
            )}
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Duration</div>
              <div>
                {planDetails?.durationInMonths} month
                {planDetails?.durationInMonths !== 1 ? "s" : ""} (
                {planDetails?.totalSessions ||
                  planDetails?.durationInMonths * 4}{" "}
                sessions)
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Sessions per Week</div>
              <div>{planDetails?.sessionsPerWeek || 2}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Max Participants</div>
              <div>{planDetails?.maxParticipants || "Unlimited"}</div>
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
          planType="CLASS"
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
                <div className="font-medium">CLASS15</div>
                <div className="text-sm text-muted-foreground">
                  Get 15% off your class enrollment
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div className="text-muted-foreground">15% off</div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleApplyDiscount("CLASS15")}
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
            <CardTitle className="text-foreground">Class Pricing</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Enrollment Fee</div>
                <div>{formatPrice(planDetails?.price || 0)}</div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <span className="font-semibold">Includes</span>
                </div>
                <div className="font-semibold">
                  <ul className="list-disc">
                    <li>
                      {planDetails?.totalSessions ||
                        (planDetails?.sessionsPerWeek || 2) *
                          (planDetails?.durationInMonths || 1) *
                          4}{" "}
                      total sessions (
                      {planDetails?.totalHours ||
                        (planDetails?.sessionsPerWeek || 2) *
                          (planDetails?.durationInMonths || 1) *
                          4}{" "}
                      hours)
                    </li>
                    <li>
                      {planDetails?.sessionsPerWeek || 2} sessions per week
                    </li>
                    <li>Course materials</li>
                    <li>Certificate of completion</li>
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
                  {gateway.isActive ? (
                    <div className="flex gap-2">
                      {availableClassId && gateway.gateway === "RAZORPAY" ? (
                        <RazorpayCheckout
                          checkoutData={createCheckoutData({
                            appointmentType: "CLASS",
                            planId: planDetails.id,
                            eventId: availableClassId,
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
                          disabled={isMaintenanceBlocked}
                        />
                      ) : availableClassId && gateway.gateway === "STRIPE" ? (
                        <StripeCheckout
                          checkoutData={createCheckoutData({
                            appointmentType: "CLASS",
                            planId: planDetails.id,
                            eventId: availableClassId,
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
                          disabled={isMaintenanceBlocked}
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
