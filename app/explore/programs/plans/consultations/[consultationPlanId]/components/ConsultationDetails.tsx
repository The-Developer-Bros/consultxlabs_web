"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { CalendarDays, Clock, GraduationCap, Globe } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PlanDetailBody } from "../../../components/PlanDetailBody";
import { PlanExpertCard } from "../../../components/PlanExpertCard";
import { PlanHero } from "../../../components/PlanHero";
import { FeatureItem } from "../../../components/FeatureItem";
import { planLevelLabel } from "@/lib/labels/plan-labels";
import { useCurrency } from "@/hooks/useCurrency";
import type { getConsultationPlanDetail } from "@/lib/data/plan-details";

type ConsultationPlanDetail = NonNullable<
  Awaited<ReturnType<typeof getConsultationPlanDetail>>
>;

const EASE = [0.16, 1, 0.3, 1] as const;

export function ConsultationDetails({
  plan,
}: Readonly<{ plan: ConsultationPlanDetail }>) {
  const { formatPrice } = useCurrency();
  const consultant = plan.consultantProfile;
  const hours = plan.durationInHours;
  const hoursLabel = `${hours} hour${hours !== 1 ? "s" : ""}`;

  return (
    <main className="min-h-screen bg-background">
      <PlanHero
        backHref="/explore/experts"
        backLabel="Back to experts"
        kind="1:1 consultation"
        title={plan.title}
        subtitle={plan.subtitle}
        price={formatPrice(plan.price)}
        priceNote="per session"
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
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <FeatureItem
                icon={<Clock />}
                label="Duration"
                value={hoursLabel}
              />
              <FeatureItem
                icon={<CalendarDays />}
                label="Format"
                value="One-to-one"
              />
              <FeatureItem
                icon={<GraduationCap />}
                label="Level"
                value={planLevelLabel(plan.level)}
              />
              <FeatureItem
                icon={<Globe />}
                label="Language"
                value={plan.language}
              />
            </div>

            <PlanDetailBody
              aboutHeading="About this consultation"
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
            <div className="rounded-2xl border border-border bg-card p-6">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                Book a session
              </p>
              <p className="mt-3 text-3xl font-semibold tabular-nums text-foreground">
                {formatPrice(plan.price)}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                for one {hours}-hour session
              </p>

              {/* Slot selection lives on the expert page, which owns the
                  availability calendar; this deep-links straight to it. */}
              <Button asChild className="mt-5 h-11 w-full rounded-xl">
                <Link href={`/explore/experts/${consultant?.id}?action=book`}>
                  Pick a slot
                </Link>
              </Button>
              <p className="mt-3 text-xs text-muted-foreground">
                Available times are shown in your timezone on the expert&apos;s
                profile.
              </p>
            </div>

            <PlanExpertCard
              heading="Your expert"
              expert={consultant}
              collaboratorsHeading="Co-hosts"
            />
          </motion.aside>
        </div>
      </div>
    </main>
  );
}
