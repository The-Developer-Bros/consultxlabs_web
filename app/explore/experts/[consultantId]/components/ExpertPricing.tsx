"use client";

import Image from "next/image";
import { User } from "@prisma/client";
import type { ConsultantDetailData } from "../types";
import { TSlotTiming } from "@/types/slots";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ConsultationPricingToggle from "./ConsultationPricingToggle";
import SubscriptionPricingToggle from "./SubscriptionPricingToggle";
import {
  Shield,
  Calendar,
  MessageSquare,
  RotateCcw,
  CheckCircle,
} from "lucide-react";
import { motion } from "framer-motion";
import { useState } from "react";

import { PricingOption } from "../defaults";

const getDurationLabel = (durationInHours: number): string => {
  return `${durationInHours} Hour${durationInHours > 1 ? "s" : ""}`;
};

const getSubscriptionDurationLabel = (durationInMonths: number): string => {
  return `${durationInMonths} Month${durationInMonths > 1 ? "s" : ""}`;
};

interface ExpertPricingProps {
  userDetails: User;
  consultantDetails: ConsultantDetailData;
  handleConsultationBooking: (consultationPlanId: string) => Promise<void>;
  handleSubscriptionBooking: (
    option: PricingOption,
    schedulingPeriod: { startDate: Date; endDate: Date },
  ) => Promise<void>;
  selectedDate: Date | null;
  setSelectedDate: (date: Date | null) => void;
  currentDate: Date;
  setCurrentDate: (date: Date) => void;
  renderCalendar: () => JSX.Element[];
  slotTimings: TSlotTiming[];
  selectedSlot: TSlotTiming | null;
  setSelectedSlot: (slot: TSlotTiming | null) => void;
  timezone: string;
  autoOpenTrial?: boolean;
  onRefreshSlots?: () => void;
}

export function ExpertPricing({
  userDetails,
  consultantDetails,
  handleConsultationBooking,
  handleSubscriptionBooking,
  selectedDate,
  setSelectedDate,
  currentDate,
  setCurrentDate,
  renderCalendar,
  slotTimings,
  selectedSlot,
  setSelectedSlot,
  timezone,
  autoOpenTrial,
  onRefreshSlots,
}: Readonly<ExpertPricingProps>) {
  const [activeServiceTab, setActiveServiceTab] = useState<
    "consultations" | "subscriptions"
  >(autoOpenTrial ? "subscriptions" : "consultations");

  const formatPricingOptions = (
    // Rows from the detail fetcher, not raw Prisma types — keeps price: number (#780)
    plans: (
      | ConsultantDetailData["consultationPlans"][number]
      | ConsultantDetailData["subscriptionPlans"][number]
    )[],
    type: "consultation" | "subscription",
  ): PricingOption[] => {
    // Count plans per duration so we can disambiguate titles when multiple
    // plans share the same duration (e.g. two 1-hour consultations).
    const durationCounts = new Map<number, number>();
    for (const plan of plans) {
      const key =
        type === "consultation" && "durationInHours" in plan
          ? plan.durationInHours
          : type === "subscription" && "durationInMonths" in plan
            ? plan.durationInMonths
            : undefined;
      if (key !== undefined) {
        durationCounts.set(key, (durationCounts.get(key) || 0) + 1);
      }
    }
    const seen = new Map<number, number>();
    const disambiguate = (label: string, duration: number): string => {
      if ((durationCounts.get(duration) || 0) <= 1) return label;
      const next = (seen.get(duration) || 0) + 1;
      seen.set(duration, next);
      return `${label} (${next})`;
    };

    return plans.map((plan) => {
      if (type === "consultation" && "durationInHours" in plan) {
        const durationLabel = disambiguate(
          getDurationLabel(plan.durationInHours),
          plan.durationInHours,
        );

        // The consultant's own inclusions win. The duration switch below is a
        // placeholder from before `whatsIncluded` existed: it asserted
        // "Document verification" and "Priority support" for every plan of a
        // given length, whether or not that consultant offered either.
        let features: string[] = plan.whatsIncluded ?? [];
        if (features.length === 0) {
          switch (plan.durationInHours) {
            case 1:
              features = ["Document verification", "1 on 1 call"];
              break;
            case 2:
              features = [
                "Document verification",
                "1 on 1 call",
                "Extended chat facility",
              ];
              break;
            case 4:
              features = [
                "Document verification",
                "1 on 1 call",
                "Extended chat facility",
                "Priority support",
              ];
              break;
            default:
              features = [`${plan.durationInHours} hour consultation`];
          }
        }

        return {
          id: plan.id,
          title: durationLabel,
          // Surface the real plan title so duplicate-duration plans
          // (e.g. "Career Strategy Session" vs "[ATEST] Career Strategy
          // Session") stay distinguishable in the panel.
          description:
            plan.subtitle ||
            plan.title ||
            `${plan.durationInHours} hour consultation`,
          price: plan.price,
          priceCurrency: plan.priceCurrency || "INR",
          duration: `${plan.durationInHours} hour${plan.durationInHours > 1 ? "s" : ""}`,
          durationInHours: plan.durationInHours,
          features: features,
        };
      } else if (type === "subscription" && "durationInMonths" in plan) {
        const durationLabel = disambiguate(
          getSubscriptionDurationLabel(plan.durationInMonths),
          plan.durationInMonths,
        );
        return {
          id: plan.id,
          title: durationLabel,
          description:
            plan.title || `${plan.durationInMonths} month subscription`,
          price: plan.price,
          priceCurrency: plan.priceCurrency || "INR",
          duration: `${plan.durationInMonths}`,
          durationInMonths: plan.durationInMonths,
          totalHours: plan.totalHours,
          totalSessions: plan.totalSessions,
          sessionsPerWeek: plan.sessionsPerWeek,
          sessionDurationInHours: plan.sessionDurationInHours,
          features: [
            `${plan.totalHours} total hours`,
            `${plan.totalSessions} sessions`,
            `${plan.sessionsPerWeek} session${plan.sessionsPerWeek > 1 ? "s" : ""} per week`,
            `${plan.sessionDurationInHours}h per session`,
            `${plan.emailSupport} email support`,
          ],
        };
      }
      // Both branches above cover every (type, plan-shape) combination
      // we ever pass in. Throw rather than returning a dummy `id: ""`
      // option — that empty id used to risk colliding with real plan ids
      // as a tab key, even though the branch is unreachable in practice.
      throw new Error(
        `formatPricingOptions: unreachable plan shape (type=${type}, plan id=${"id" in plan ? plan.id : "?"})`,
      );
    });
  };

  const consultationOptions = formatPricingOptions(
    consultantDetails.consultationPlans.sort(
      (a, b) => a.durationInHours - b.durationInHours,
    ),
    "consultation",
  );
  const subscriptionOptions = formatPricingOptions(
    consultantDetails.subscriptionPlans.sort(
      (a, b) => a.durationInMonths - b.durationInMonths,
    ),
    "subscription",
  );

  const hasConsultations = consultationOptions.length > 0;
  const hasSubscriptions = subscriptionOptions.length > 0;

  return (
    <div className="sticky top-24 space-y-4">
      {/* Profile Image Card — refined, no flat border */}
      <div className="rounded-3xl overflow-hidden shadow-2xl shadow-black/30 ring-1 ring-white/10">
        <div className="aspect-[4/3] relative">
          <Image
            alt="Profile"
            className="object-cover"
            fill
            src={userDetails.image || "/placeholder.svg"}
            sizes="(max-width: 768px) 100vw, 400px"
          />
        </div>
      </div>

      {/* Pricing Card — glassmorphism dark */}
      <div className="bg-zinc-950/90 backdrop-blur-xl rounded-3xl p-6 shadow-2xl shadow-black/40 border border-white/[0.07] ring-1 ring-white/[0.04]">
        {/* Header */}
        <div className="text-center mb-5">
          <h3 className="text-xl font-bold text-white mb-1">Book a Session</h3>
          <p className="text-xs text-zinc-500 tracking-wide uppercase font-medium">
            Choose your preferred option
          </p>
        </div>

        {hasConsultations && hasSubscriptions ? (
          <Tabs
            value={activeServiceTab}
            onValueChange={(v) =>
              setActiveServiceTab(v as "consultations" | "subscriptions")
            }
            className="w-full"
          >
            {/* Segmented pill toggle for service type */}
            <TabsList className="relative flex p-1 bg-white/[0.06] rounded-2xl border border-white/[0.08] backdrop-blur-sm mb-6 h-auto">
              {(["consultations", "subscriptions"] as const).map((tab) => (
                <TabsTrigger
                  key={tab}
                  value={tab}
                  className="relative flex-1 py-2.5 text-xs sm:text-sm font-medium rounded-xl flex items-center justify-center gap-2 data-[state=active]:text-zinc-900 data-[state=active]:bg-transparent data-[state=active]:shadow-none text-zinc-400 transition-colors duration-300 z-10 h-auto"
                >
                  {activeServiceTab === tab && (
                    <motion.div
                      layoutId="service-type-pill"
                      className="absolute inset-0 bg-white rounded-xl shadow-sm"
                      transition={{
                        type: "spring",
                        bounce: 0.15,
                        duration: 0.35,
                      }}
                    />
                  )}
                  <span className="relative z-10 flex items-center gap-2">
                    {tab === "consultations" ? (
                      <Calendar className="w-3.5 h-3.5" />
                    ) : (
                      <MessageSquare className="w-3.5 h-3.5" />
                    )}
                    {tab === "consultations" ? "One-time" : "Mentorship"}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="consultations">
              <ConsultationPricingToggle
                consultationOptions={consultationOptions}
                consultantDetails={consultantDetails}
                handleConsultationBooking={handleConsultationBooking}
                selectedDate={selectedDate}
                setSelectedDate={setSelectedDate}
                currentDate={currentDate}
                setCurrentDate={setCurrentDate}
                renderCalendar={renderCalendar}
                slotTimings={slotTimings}
                selectedSlot={selectedSlot}
                setSelectedSlot={setSelectedSlot}
                timezone={timezone}
                onRefreshSlots={onRefreshSlots}
              />
            </TabsContent>
            <TabsContent value="subscriptions">
              <SubscriptionPricingToggle
                subscriptionOptions={subscriptionOptions}
                consultantDetails={consultantDetails}
                handleSubscriptionBooking={handleSubscriptionBooking}
                timezone={timezone}
                autoOpenTrial={autoOpenTrial}
              />
            </TabsContent>
          </Tabs>
        ) : hasConsultations ? (
          <ConsultationPricingToggle
            consultationOptions={consultationOptions}
            consultantDetails={consultantDetails}
            handleConsultationBooking={handleConsultationBooking}
            selectedDate={selectedDate}
            setSelectedDate={setSelectedDate}
            currentDate={currentDate}
            setCurrentDate={setCurrentDate}
            renderCalendar={renderCalendar}
            slotTimings={slotTimings}
            selectedSlot={selectedSlot}
            setSelectedSlot={setSelectedSlot}
            timezone={timezone}
            onRefreshSlots={onRefreshSlots}
          />
        ) : hasSubscriptions ? (
          <SubscriptionPricingToggle
            subscriptionOptions={subscriptionOptions}
            consultantDetails={consultantDetails}
            handleSubscriptionBooking={handleSubscriptionBooking}
            timezone={timezone}
          />
        ) : (
          <div className="text-center py-8">
            <p className="text-zinc-400">No pricing plans available</p>
          </div>
        )}

        {/* Trust Badges — chip style */}
        <div className="mt-6 pt-5 border-t border-white/[0.06]">
          <div className="flex items-center justify-center gap-2 flex-wrap">
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.06] text-xs text-zinc-500">
              <Shield className="w-3 h-3" />
              Secure
            </span>
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.06] text-xs text-zinc-500">
              <RotateCcw className="w-3 h-3" />
              Money-back
            </span>
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.06] text-xs text-zinc-500">
              <CheckCircle className="w-3 h-3" />
              Verified
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
