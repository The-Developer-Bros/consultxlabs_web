"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Calendar,
  Clock,
  Globe,
  GraduationCap,
  Users,
  Video,
} from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";

import { PlanDetailBody } from "../../../components/PlanDetailBody";
import { PlanExpertCard } from "../../../components/PlanExpertCard";
import {
  PlanHero,
  type PlanHeroStatusTone,
} from "../../../components/PlanHero";
import { FeatureItem } from "../../../components/FeatureItem";
import { planLevelLabel } from "@/lib/labels/plan-labels";
import { ClientWebinarRegistration } from "./ClientWebinarRegistration";
import { generateProgramImageUrl } from "@/lib/explore/programs";
import { useCurrency } from "@/hooks/useCurrency";
import type { TWebinarPlanData, TSessionStatus } from "../types";

const EASE = [0.16, 1, 0.3, 1] as const;

const STATUS_TONE: Record<TSessionStatus, PlanHeroStatusTone> = {
  "Happening Now": "live",
  Upcoming: "upcoming",
  Completed: "done",
  "To be announced": "neutral",
};

interface WebinarDetailsProps {
  readonly plan: TWebinarPlanData;
  readonly nextSession: Date | string | undefined;
  readonly webinarId?: string;
}

export function WebinarDetails({
  plan,
  nextSession,
  webinarId,
}: WebinarDetailsProps) {
  const { formatPrice } = useCurrency();
  const [timeZone, setTimeZone] = useState("UTC");
  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  let sessionStatus: TSessionStatus = "To be announced";
  let formattedNextSessionDisplay = "To be announced";

  if (
    nextSession &&
    plan.durationInHours !== null &&
    plan.durationInHours !== undefined
  ) {
    const sessionStart = new Date(nextSession);
    const durationInMilliseconds = plan.durationInHours * 60 * 60 * 1000;
    const sessionEnd = new Date(
      sessionStart.getTime() + durationInMilliseconds,
    );
    const now = new Date();

    if (now > sessionEnd) {
      sessionStatus = "Completed";
      formattedNextSessionDisplay = `Ended on ${formatInTimeZone(sessionEnd, timeZone, "MMMM d, yyyy 'at' h:mm a zzz")}`;
    } else if (now >= sessionStart && now <= sessionEnd) {
      sessionStatus = "Happening Now";
      formattedNextSessionDisplay = `Ends at ${formatInTimeZone(sessionEnd, timeZone, "h:mm a zzz")}`;
    } else if (now < sessionStart) {
      sessionStatus = "Upcoming";
      formattedNextSessionDisplay = formatInTimeZone(
        sessionStart,
        timeZone,
        "MMMM d, yyyy 'at' h:mm a zzz",
      );
    }
  } else if (nextSession) {
    sessionStatus = "Upcoming";
    formattedNextSessionDisplay = formatInTimeZone(
      new Date(nextSession),
      timeZone,
      "MMMM d, yyyy 'at' h:mm a zzz",
    );
  }

  const consultant = plan.consultantProfile;
  const hours = plan.durationInHours;
  const hoursLabel = `${hours} hour${hours !== 1 ? "s" : ""}`;

  return (
    <main className="min-h-screen bg-background">
      <PlanHero
        backHref="/explore/programs"
        backLabel="Back to programs"
        kind="Webinar"
        status={{ label: sessionStatus, tone: STATUS_TONE[sessionStatus] }}
        title={plan.title}
        subtitle={plan.subtitle}
        price={formatPrice(plan.price)}
        priceNote={`for a ${hours}-hour session`}
        imageUrl={generateProgramImageUrl(plan.id, 1600, 600, plan.imageUrl)}
        host={
          consultant?.user?.name
            ? {
                name: consultant.user.name,
                image: consultant.user.image ?? null,
                href: `/explore/experts/${consultant.id}`,
              }
            : null
        }
      />

      <div className="mx-auto max-w-[1600px] px-4 py-10 md:px-8 md:py-14 lg:px-12">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-12">
          <motion.div
            className="space-y-6"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
          >
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <FeatureItem
                icon={<Calendar />}
                label={
                  sessionStatus === "Happening Now" ||
                  sessionStatus === "Completed"
                    ? "Status"
                    : "Next session"
                }
                value={formattedNextSessionDisplay}
              />
              <FeatureItem
                icon={<Clock />}
                label="Duration"
                value={hoursLabel}
              />
              <FeatureItem
                icon={<Users />}
                label="Seats"
                value={`Up to ${plan.maxParticipants}`}
              />
              {/* Sessions run on the platform's own video room, so the
                  "Platform" cell that used to fall back to "Zoom" said
                  something that was never true. */}
              <FeatureItem
                icon={<Video />}
                label="Format"
                value="Live online"
              />
              <FeatureItem
                icon={<Globe />}
                label="Language"
                value={plan.language ?? "English"}
              />
              <FeatureItem
                icon={<GraduationCap />}
                label="Level"
                value={planLevelLabel(plan.level)}
              />
            </div>

            {/* Shared with the other three plan pages — see PlanDetailBody. */}
            <PlanDetailBody
              aboutHeading="About this webinar"
              description={plan.description}
              learningOutcomes={plan.learningOutcomes}
              targetAudience={plan.targetAudience}
              whatsIncluded={plan.whatsIncluded}
              prerequisites={plan.prerequisites}
              materialProvided={plan.materialProvided}
              faqs={plan.faqs}
              topics={plan.topics}
            />
          </motion.div>

          <motion.aside
            className="space-y-4 lg:sticky lg:top-[calc(var(--header-height,5rem)+1rem)] lg:self-start"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
          >
            <ClientWebinarRegistration
              webinarPlanId={plan.id}
              webinarId={webinarId}
              price={plan.price}
              currency={plan.priceCurrency}
              nextSessionDate={nextSession ? new Date(nextSession) : undefined}
              sessionStatus={sessionStatus}
              appointment={plan.webinars?.[0]?.appointment}
              maxParticipants={plan.maxParticipants ?? 100}
              instanceMaxParticipants={
                plan.webinars?.[0]?.maxParticipants ?? null
              }
              consultantUserId={plan.consultantProfile?.user?.id}
            />
            <PlanExpertCard
              heading="Your host"
              expert={consultant}
              collaboratorsHeading="Co-hosts"
              collaborators={plan.collaborators}
            />
          </motion.aside>
        </div>
      </div>
    </main>
  );
}
