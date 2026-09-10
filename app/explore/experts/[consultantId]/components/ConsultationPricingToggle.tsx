"use client";

import { CalendarIcon } from "@/assets/icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { motion } from "framer-motion";
import { ClockIcon, CheckCircle2, RefreshCw } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { PricingOption } from "../defaults";
import { TSlotTiming } from "@/types/slots";
import { breakDownSlotsPreservingStatus } from "@/utils/timeSlotsProcessing";
import { MINIMUM_BOOKING_LEAD_TIME_MS } from "@/lib/payments/constants";
import {
  consumePurchaseIntent,
  stashPurchaseIntent,
} from "@/utils/purchase-intent";
import { useToast } from "@/hooks/use-toast";
import { useCurrency } from "@/hooks/useCurrency";

interface ConsultantDetailsForBooking {
  id: string;
  scheduleType?: string;
  consultationPlans: Array<{
    id: string;
    durationInHours: number;
  }>;
}

interface ConsultationPricingToggleProps {
  consultationOptions: PricingOption[];
  consultantDetails: ConsultantDetailsForBooking;
  handleConsultationBooking: (consultationPlanId: string) => void;
  selectedDate: Date | null;
  setSelectedDate: (date: Date | null) => void;
  currentDate: Date;
  setCurrentDate: (date: Date) => void;
  renderCalendar: () => JSX.Element[];
  slotTimings: TSlotTiming[];
  selectedSlot: TSlotTiming | null;
  setSelectedSlot: (slot: TSlotTiming | null) => void;
  timezone: string;
  onRefreshSlots?: () => void;
}

type SlotWithStatus = TSlotTiming & {
  isAllocated: boolean;
  bookingStatus: "available" | "partially-booked" | "fully-booked";
  _isPast: boolean;
};

export default function ConsultationPricingToggle({
  consultationOptions,
  handleConsultationBooking,
  selectedDate,
  setSelectedDate,
  currentDate,
  setCurrentDate,
  renderCalendar,
  slotTimings,
  selectedSlot,
  setSelectedSlot,
  timezone,
  consultantDetails,
  onRefreshSlots,
}: Readonly<ConsultationPricingToggleProps>) {
  const { data: session } = useSession();
  const { toast } = useToast();
  const { formatPrice } = useCurrency();
  // Track the active plan by id so plans that share a duration (e.g. two
  // 1-hour consultations) remain independently selectable and bookable.
  const [activeConsultationOption, setActiveConsultationOption] =
    useState<string>(consultationOptions[0]?.id ?? "");
  const [isRequestingApproval, setIsRequestingApproval] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const activePlanOption = useMemo(
    () =>
      consultationOptions.find((opt) => opt.id === activeConsultationOption),
    [activeConsultationOption, consultationOptions],
  );

  const selectedDuration = activePlanOption?.durationInHours ?? 1;

  // Past days are disabled in the grid, so browsing earlier months is pointless.
  const isViewingCurrentMonth = useMemo(() => {
    const now = new Date();
    return (
      currentDate.getFullYear() === now.getFullYear() &&
      currentDate.getMonth() === now.getMonth()
    );
  }, [currentDate]);

  const availableSlots = useMemo((): SlotWithStatus[] => {
    if (
      !slotTimings ||
      slotTimings.length === 0 ||
      !timezone ||
      !selectedDate
    ) {
      return [];
    }

    const slotsWithAllocation = slotTimings.map((slot) => ({
      ...slot,
      isAllocated: slot.isAllocated || false,
      bookingStatus: (slot.bookingStatus || "available") as
        | "available"
        | "partially-booked"
        | "fully-booked",
    }));

    // Use breakDownSlotsPreservingStatus to create duration windows
    // WITHOUT discarding the API-computed bookingStatus
    const brokenDownSlots = breakDownSlotsPreservingStatus(
      slotsWithAllocation,
      selectedDuration,
      timezone,
    );

    // Add client-side past-slot detection
    const now = Date.now();
    return brokenDownSlots.map((slot) => ({
      ...slot,
      _isPast:
        new Date(slot.startsAt).getTime() <
        now + MINIMUM_BOOKING_LEAD_TIME_MS,
    }));
  }, [slotTimings, selectedDuration, timezone, selectedDate]);

  // #booking-journey — restore a slot stashed before the auth bounce. Runs
  // once per mount, and only once slots have actually loaded: the stashed
  // pick is only applied when it still exists in the calendar (not past, not
  // fully booked), so a stale intent can never select an invalid slot.
  const purchaseIntentConsumedRef = useRef(false);
  useEffect(() => {
    if (purchaseIntentConsumedRef.current) return;
    if (availableSlots.length === 0 || !session?.user?.id) return;
    purchaseIntentConsumedRef.current = true;

    const intent = consumePurchaseIntent(consultantDetails.id);
    if (!intent) return;

    if (
      consultationOptions.some((opt) => opt.id === intent.consultationPlanId)
    ) {
      setActiveConsultationOption(intent.consultationPlanId);
    }

    const match = availableSlots.find(
      (slot) =>
        slot.startsAt === intent.slot.startsAt &&
        slot.endsAt === intent.slot.endsAt &&
        !slot._isPast &&
        slot.bookingStatus !== "fully-booked",
    );
    if (match) {
      setSelectedSlot(match);
      toast({
        title: "Welcome back",
        description: "Your previously selected time slot was restored.",
      });
    }
  }, [
    availableSlots,
    consultationOptions,
    consultantDetails.id,
    session?.user?.id,
    setActiveConsultationOption,
    setSelectedSlot,
    toast,
  ]);

  const handleRequestForApproval = async () => {
    if (!selectedSlot || !consultantDetails) {
      toast({ title: "Please select a time slot", variant: "destructive" });
      return;
    }

    if (!session?.user?.id) {
      // B9 (booking-journey audit) — redirect to sign-in with a callback URL
      // instead of dead-ending in a toast. The Buy path already does this
      // implicitly: /checkout/* is middleware-protected and bounces here with
      // callbackUrl. The request-for-approval path runs client-side, so it
      // must build the same redirect itself or guests hit a wall.
      //
      // #booking-journey — the profile-page callbackUrl alone would lose the
      // picked slot (the user returns to an unselected calendar). Stash the
      // full selection in sessionStorage; ConsultationPricingToggle restores
      // it on the next authenticated render.
      stashPurchaseIntent({
        consultantId: consultantDetails.id,
        consultationPlanId: activeConsultationOption,
        slot: {
          startsAt: selectedSlot.startsAt,
          endsAt: selectedSlot.endsAt,
          type: (
            selectedSlot as TSlotTiming & { type?: "WEEKLY" | "CUSTOM" }
          ).type,
          slotOfAvailabilityId: (
            selectedSlot as TSlotTiming & { slotOfAvailabilityId?: string }
          ).slotOfAvailabilityId,
        },
      });
      const callbackUrl = `${window.location.pathname}${window.location.search}`;
      window.location.href = `/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`;
      return;
    }

    // Look up the plan by the user's active tab selection (not by slot
    // duration) so duplicate-duration plans resolve to the correct one.
    const activePlan = consultantDetails.consultationPlans.find(
      (plan: { id: string; durationInHours: number }) =>
        plan.id === activeConsultationOption,
    );

    if (!activePlan) {
      toast({ title: "Invalid consultation plan", variant: "destructive" });
      return;
    }

    setIsRequestingApproval(true);

    try {
      const requestBody: {
        consultantProfileId: string;
        startsAt: string;
        endsAt: string;
        consultationPlanId: string;
        slotOfAvailabilityWeeklyId?: string;
        slotOfAvailabilityCustomId?: string;
      } = {
        consultantProfileId: consultantDetails.id,
        startsAt: selectedSlot.startsAt,
        endsAt: selectedSlot.endsAt,
        consultationPlanId: activePlan.id,
      };

      if (selectedSlot.type === "WEEKLY") {
        requestBody.slotOfAvailabilityWeeklyId =
          selectedSlot.slotOfAvailabilityId;
      } else {
        requestBody.slotOfAvailabilityCustomId =
          selectedSlot.slotOfAvailabilityId;
      }

      const response = await fetch("/api/slots/request-for-approval", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to submit request for approval");
      }

      toast({
        title: "Request Submitted",
        description:
          "Your request for approval has been submitted successfully. The consultant will review and respond soon.",
        variant: "default",
      });

      setSelectedSlot(null);
    } catch (error) {
      console.error("Error requesting approval:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to submit request for approval",
        variant: "destructive",
      });
    } finally {
      setIsRequestingApproval(false);
    }
  };

  const handleBookNowClick = () => {
    const today = new Date();
    setSelectedDate(today);
    setCurrentDate(new Date(today.getFullYear(), today.getMonth(), 1));
  };

  if (consultationOptions.length === 0) {
    return (
      <div className="w-full p-8 text-center text-zinc-400">
        <p>No consultation plans available at the moment.</p>
      </div>
    );
  }

  if (
    session?.user?.role &&
    ["consultant", "staff"].includes(session.user.role.toLowerCase())
  ) {
    return (
      <div className="w-full p-8 text-center space-y-3">
        <h3 className="text-2xl font-medium tracking-tight text-zinc-300">
          Consultee Access Required
        </h3>
        <p className="text-zinc-500">
          To book consultations, please sign in with a consultee account.
        </p>
      </div>
    );
  }

  return (
    <Tabs
      value={activeConsultationOption}
      onValueChange={setActiveConsultationOption}
      className="w-full space-y-5"
    >
      {/* Segmented pill duration toggle */}
      <TabsList className="relative flex p-1 bg-white/[0.06] rounded-2xl border border-white/[0.08] backdrop-blur-sm h-auto">
        {consultationOptions.map((option) => {
          const isActive = activeConsultationOption === option.id;
          return (
            <TabsTrigger
              key={option.id}
              value={option.id}
              className="relative flex-1 py-2.5 text-xs sm:text-sm font-medium rounded-xl data-[state=active]:text-zinc-900 data-[state=active]:bg-transparent data-[state=active]:shadow-none text-zinc-400 transition-colors duration-300 z-10 h-auto whitespace-nowrap"
            >
              {isActive && (
                <motion.div
                  layoutId="consultation-duration-pill"
                  className="absolute inset-0 bg-white rounded-xl shadow-sm"
                  transition={{ type: "spring", bounce: 0.15, duration: 0.35 }}
                />
              )}
              <span className="relative z-10">{option.title}</span>
            </TabsTrigger>
          );
        })}
      </TabsList>

      <div className="grid grid-cols-1 gap-4">
        {consultationOptions.map((option) => {
          const isActive = activeConsultationOption === option.id;
          return (
          <motion.div
            key={option.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{
              opacity: isActive ? 1 : 0,
              y: 0,
            }}
            transition={{ duration: 0.2 }}
            className={isActive ? "block" : "hidden"}
          >
            {/* Pricing content — no nested dark card, lives directly in glass parent */}
            <div className="space-y-1">
              <h3 className="text-lg font-bold text-white">{option.title}</h3>
              <p className="text-xs text-zinc-500">{option.description}</p>
            </div>

            <div className="flex items-end gap-2 my-5">
              <span className="text-5xl font-bold tracking-tight text-white">
                {formatPrice(option.price)}
              </span>
              <span className="text-zinc-500 text-sm mb-1.5">/ session</span>
            </div>

            {option.features && option.features.length > 0 && (
              <>
                <div className="border-t border-white/[0.06] mb-4" />
                <div className="space-y-2 mb-5">
                  <p className="text-xs text-zinc-500 font-medium uppercase tracking-wider">
                    Includes
                  </p>
                  <ul className="space-y-2">
                    {option.features.map((feature, index) => (
                      <li
                        key={`feature-${index}`}
                        className="text-zinc-200 flex items-center text-sm"
                      >
                        <CheckCircle2 className="w-4 h-4 mr-2.5 text-emerald-400 flex-shrink-0" />
                        {feature}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}

            {/* Two CTAs: read first, or book now. The toggle stays a chooser
                and hands detail off to the plan page. */}
            <Button
              asChild
              variant="outline"
              className="w-full mb-3 bg-white/[0.05] border border-white/[0.12] text-zinc-200 hover:bg-white/[0.10] hover:text-white font-medium rounded-xl h-11 text-sm transition-all duration-200"
            >
              <Link href={`/explore/programs/plans/consultations/${option.id}`}>
                Open details
              </Link>
            </Button>

            <Dialog>
              <DialogTrigger asChild>
                <Button
                  className="w-full bg-white text-zinc-900 hover:bg-zinc-100 font-semibold rounded-xl h-12 text-sm tracking-wide transition-all duration-200 hover:shadow-[0_0_20px_rgba(255,255,255,0.15)]"
                  onClick={handleBookNowClick}
                >
                  Book Now
                </Button>
              </DialogTrigger>
              <DialogContent
                className="z-[1002] inset-0 left-0 top-0 h-[100dvh] w-full max-w-none translate-x-0 translate-y-0 rounded-none border-0 sm:left-[50%] sm:top-[50%] sm:h-[92dvh] sm:w-[calc(100%-3rem)] sm:max-w-[1100px] lg:max-w-[1200px] sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-2xl sm:border sm:border-zinc-800 flex flex-col overflow-hidden bg-zinc-900 text-white p-0 shadow-2xl"
                // Inline zIndex: arbitrary-class merge with the z-50 base in
                // dialog.tsx is ordering-dependent; the nav (z-[1000]) and
                // announcement bar (z-[1001]) must never paint above this.
                style={{ zIndex: 1002 }}
              >
                <DialogHeader className="flex-none p-4 lg:p-6 border-b border-zinc-800">
                  <DialogTitle className="text-lg sm:text-xl lg:text-2xl font-semibold">
                    Book {option.title} Consultation
                  </DialogTitle>
                  <DialogDescription className="hidden lg:block text-zinc-400 text-sm lg:text-base">
                    Select a date and time for your {option.duration}{" "}
                    consultation
                  </DialogDescription>
                </DialogHeader>
                {/* Stretch-to-fit body: the dialog never scrolls on mdh+
                    (wide AND tall) screens — each pane flexes and only the
                    slot list scrolls internally. Short/wide screens fall
                    back to the stacked, body-scrollable layout. */}
                <div className="flex-1 min-h-0 grid grid-cols-1 mdh:grid-cols-2 mdh:grid-rows-1 gap-4 md:gap-8 lg:gap-10 p-4 sm:p-6 lg:p-8 overflow-y-auto mdh:overflow-hidden">
                  {/* Calendar Section */}
                  <div className="mdh:min-h-0 flex flex-col">
                    <h3 className="flex-none text-base sm:text-lg font-semibold mb-2 sm:mb-3 flex items-center text-white">
                      <CalendarIcon className="mr-2 h-4 w-4 sm:h-5 sm:w-5 text-zinc-400" />{" "}
                      Select a Date
                    </h3>
                    <div className="mdh:min-h-0 mdh:flex-1 flex flex-col bg-zinc-800/60 p-3 sm:p-4 lg:p-5 rounded-xl border border-zinc-700/50 overflow-hidden [--cell:clamp(26px,5.5dvh,36px)] mdh:[container-type:size] mdh:[--cell:clamp(20px,calc(16.6cqh_-_22px),48px)]">
                      <div className="flex-none flex justify-between items-center mb-2 sm:mb-3">
                        <Button
                          variant="ghost"
                          size="default"
                          className="text-zinc-400 hover:text-white hover:bg-zinc-700/50 h-8 w-8 sm:h-10 sm:w-10 text-base sm:text-lg disabled:opacity-30"
                          disabled={isViewingCurrentMonth}
                          aria-label={
                            isViewingCurrentMonth
                              ? "No earlier months"
                              : "Previous month"
                          }
                          onClick={() =>
                            setCurrentDate(
                              new Date(
                                currentDate.getFullYear(),
                                currentDate.getMonth() - 1,
                                1,
                              ),
                            )
                          }
                        >
                          &lt;
                        </Button>
                        <span className="font-semibold text-white text-base sm:text-lg">
                          {currentDate.toLocaleString("default", {
                            month: "long",
                            year: "numeric",
                          })}
                        </span>
                        <Button
                          variant="ghost"
                          size="default"
                          className="text-zinc-400 hover:text-white hover:bg-zinc-700/50 h-8 w-8 sm:h-10 sm:w-10 text-base sm:text-lg"
                          onClick={() =>
                            setCurrentDate(
                              new Date(
                                currentDate.getFullYear(),
                                currentDate.getMonth() + 1,
                                1,
                              ),
                            )
                          }
                        >
                          &gt;
                        </Button>
                      </div>
                      <div className="flex-none grid grid-cols-7 justify-items-center gap-x-1 sm:gap-x-3 text-center text-xs sm:text-base font-medium text-zinc-400 mb-1.5 sm:mb-3">
                        <div>Mo</div>
                        <div>Tu</div>
                        <div>We</div>
                        <div>Th</div>
                        <div>Fr</div>
                        <div>Sa</div>
                        <div>Su</div>
                      </div>
                      <div className="grid grid-cols-7 justify-items-center gap-x-1 gap-y-1 sm:gap-x-2 sm:gap-y-2">
                        {renderCalendar()}
                      </div>
                      {/* Dot colors share the slot list legend below — no
                          separate calendar legend needed. */}
                    </div>
                  </div>

                  {/* Available Slots Section */}
                  <div className="mdh:min-h-0 flex flex-col">
                    <div className="flex-none flex items-center justify-between mb-3">
                      <h3 className="text-base sm:text-lg font-semibold flex items-center text-white">
                        <ClockIcon className="mr-2 h-4 w-4 sm:h-5 sm:w-5 text-zinc-400" />{" "}
                        Available {selectedDuration} hour Slots
                      </h3>
                      {onRefreshSlots && (
                        <button
                          type="button"
                          className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-700/50 transition-colors"
                          title="Refresh slot availability"
                          onClick={async () => {
                            setIsRefreshing(true);
                            try {
                              await onRefreshSlots();
                            } finally {
                              setIsRefreshing(false);
                            }
                          }}
                          disabled={isRefreshing}
                        >
                          <RefreshCw
                            className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
                          />
                        </button>
                      )}
                    </div>
                    {consultantDetails?.scheduleType && (
                      <div className="flex-none hidden mdh:block mb-3 p-2.5 bg-zinc-800/40 rounded-xl border border-zinc-700/50">
                        <p className="text-xs sm:text-sm text-zinc-400">
                          This consultant prefers{" "}
                          <span
                            className={`px-2 py-1 rounded text-xs font-medium ${
                              consultantDetails.scheduleType === "WEEKLY"
                                ? "bg-zinc-700 text-zinc-300"
                                : "bg-zinc-700 text-zinc-300"
                            }`}
                          >
                            {consultantDetails.scheduleType === "WEEKLY"
                              ? "📅 Weekly"
                              : "🎯 Custom"}
                          </span>{" "}
                          scheduling
                        </p>
                      </div>
                    )}
                    <div className="mdh:min-h-0 mdh:flex-1 grid grid-cols-1 content-start gap-2.5 sm:gap-3 max-h-[30dvh] mdh:max-h-none overflow-y-auto pr-1 sm:pr-2">
                      {availableSlots.length > 0 ? (
                        <>
                          {availableSlots.map((slot, index) => {
                            const isSelected =
                              selectedSlot?.slotId === slot.slotId &&
                              selectedSlot?.localStartTime ===
                                slot.localStartTime;
                            const isPast = slot._isPast;
                            const bookingStatus =
                              slot.bookingStatus || "available";
                            const isFullyBooked =
                              bookingStatus === "fully-booked";
                            const isPartiallyBooked =
                              bookingStatus === "partially-booked";
                            const isAllocated = slot.isAllocated;
                            const isDisabled = isPast || isFullyBooked;

                            return (
                              <button
                                key={`${slot.slotId}-${index}`}
                                className={`w-full p-3 sm:p-4 text-sm sm:text-base font-medium transition-all duration-200 rounded-xl text-left
                                    ${
                                      isSelected
                                        ? "bg-white text-zinc-900 shadow-md ring-2 ring-white"
                                        : isPast
                                          ? "bg-zinc-800/30 text-zinc-600 border border-zinc-700/30 cursor-not-allowed opacity-60"
                                          : isFullyBooked
                                            ? "bg-rose-500/10 text-rose-400 border border-rose-500/30 cursor-not-allowed"
                                            : isPartiallyBooked || isAllocated
                                              ? "bg-amber-500/10 text-amber-400 border border-amber-500/30 hover:bg-amber-500/20"
                                              : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20 hover:border-emerald-400"
                                    }`}
                                onClick={() =>
                                  !isDisabled && setSelectedSlot(slot)
                                }
                                disabled={isDisabled}
                              >
                                <div className="flex items-center">
                                  <ClockIcon className="mr-3 h-5 w-5 opacity-70" />
                                  <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                      <span>
                                        {slot.localStartTime} -{" "}
                                        {slot.localEndTime}
                                      </span>
                                      {slot.type && (
                                        <span className="px-2 py-0.5 rounded text-xs bg-zinc-700/50 text-zinc-400">
                                          {slot.type === "WEEKLY"
                                            ? "📅"
                                            : "🎯"}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  {isPast && (
                                    <span className="ml-auto text-xs font-medium text-zinc-500">
                                      Past
                                    </span>
                                  )}
                                  {isFullyBooked && !isPast && (
                                    <span className="ml-auto text-xs font-medium text-rose-400">
                                      Fully booked
                                    </span>
                                  )}
                                  {isPartiallyBooked &&
                                    !isPast &&
                                    !isAllocated && (
                                      <span className="ml-auto text-xs font-medium text-amber-400">
                                        Partially booked
                                      </span>
                                    )}
                                  {isAllocated &&
                                    !isPast &&
                                    !isFullyBooked && (
                                      <span className="ml-auto text-xs font-medium text-amber-400">
                                        Request approval
                                      </span>
                                    )}
                                </div>
                              </button>
                            );
                          })}
                          {/* Legend strip */}
                          <div className="flex flex-wrap gap-3 pt-3 border-t border-zinc-800/50 mt-1">
                            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                              <div className="w-2.5 h-2.5 rounded-full bg-emerald-400" />{" "}
                              Available
                            </div>
                            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                              <div className="w-2.5 h-2.5 rounded-full bg-amber-400" />{" "}
                              Partially booked
                            </div>
                            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                              <div className="w-2.5 h-2.5 rounded-full bg-rose-400" />{" "}
                              Fully booked
                            </div>
                            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                              <div className="w-2.5 h-2.5 rounded-full bg-zinc-600" />{" "}
                              Past
                            </div>
                          </div>
                        </>
                      ) : (
                        <p className="text-zinc-500 text-sm py-4 text-center">
                          No available slots for the selected date.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex-none bg-zinc-800/50 px-4 sm:px-6 lg:px-8 py-3 lg:py-4 flex justify-end rounded-b-2xl border-t border-zinc-800">
                  <Button
                    className="bg-white text-zinc-900 hover:bg-zinc-100 font-medium px-6 sm:px-8 h-10 sm:h-12 text-sm sm:text-base"
                    onClick={
                      selectedSlot?.isAllocated
                        ? handleRequestForApproval
                        : () => handleConsultationBooking(option.id)
                    }
                    disabled={
                      !selectedSlot ||
                      isRequestingApproval ||
                      (selectedSlot as SlotWithStatus)?._isPast ||
                      selectedSlot?.bookingStatus === "fully-booked"
                    }
                  >
                    {isRequestingApproval
                      ? "Submitting..."
                      : selectedSlot?.isAllocated
                        ? "Request for Approval"
                        : "Continue to Checkout"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </motion.div>
          );
        })}
      </div>
    </Tabs>
  );
}
