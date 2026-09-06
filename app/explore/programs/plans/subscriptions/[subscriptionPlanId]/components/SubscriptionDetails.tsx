"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import {
  CalendarDays,
  Clock,
  GraduationCap,
  Globe,
  Repeat,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { PlanDetailBody } from "../../../components/PlanDetailBody";
import { PlanExpertCard } from "../../../components/PlanExpertCard";
import { PlanHero } from "../../../components/PlanHero";
import { FeatureItem } from "../../../components/FeatureItem";
import { planLevelLabel } from "@/lib/labels/plan-labels";
import { useCurrency } from "@/hooks/useCurrency";
import type { getSubscriptionPlanDetail } from "@/lib/data/plan-details";

type SubscriptionPlanDetail = NonNullable<
  Awaited<ReturnType<typeof getSubscriptionPlanDetail>>
>;

const EASE = [0.16, 1, 0.3, 1] as const;

const CHIP =
  "inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground";

export function SubscriptionDetails({
  plan,
}: Readonly<{ plan: SubscriptionPlanDetail }>) {
  const { formatPrice } = useCurrency();
  const consultant = plan.consultantProfile;
  const months = plan.durationInMonths;
  const monthsLabel = `${months} month${months !== 1 ? "s" : ""}`;

  return (
    <main className="min-h-screen bg-background">
      <PlanHero
        backHref="/explore/experts"
        backLabel="Back to experts"
        kind="Mentorship programme"
        title={plan.title}
        subtitle={plan.subtitle}
        price={formatPrice(plan.price)}
        priceNote={`for ${monthsLabel}`}
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
                icon={<CalendarDays />}
                label="Duration"
                value={monthsLabel}
              />
              <FeatureItem
                icon={<Repeat />}
                label="Cadence"
                value={`${plan.sessionsPerWeek} / week`}
              />
              <FeatureItem
                icon={<Clock />}
                label="Sessions"
                value={`${plan.totalSessions} total`}
              />
              <FeatureItem
                icon={<GraduationCap />}
                label="Level"
                value={planLevelLabel(plan.level)}
              />
            </div>

            <PlanDetailBody
              aboutHeading="About this programme"
              description={plan.description}
              learningOutcomes={plan.learningOutcomes}
              targetAudience={plan.targetAudience}
              whatsIncluded={plan.whatsIncluded}
              curriculum={plan.subscriptionContents}
              curriculumHeading="Your roadmap"
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
                Subscribe
              </p>
              <p className="mt-3 text-3xl font-semibold tabular-nums text-foreground">
                {formatPrice(plan.price)}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                for {monthsLabel} · {plan.totalHours}h total
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
                <span className={CHIP}>
                  <Globe className="h-3 w-3" />
                  {plan.language}
                </span>
                {plan.trialEnabled && (
                  <span className={CHIP}>
                    <Sparkles className="h-3 w-3" />
                    Trial available
                  </span>
                )}
              </div>

              <Button asChild className="mt-5 h-11 w-full rounded-xl">
                <Link href={`/checkout/plans/subscription/${plan.id}`}>
                  Subscribe
                </Link>
              </Button>
            </div>

            <PlanExpertCard
              heading="Your mentor"
              expert={consultant}
              collaboratorsHeading="Co-mentors"
            />
          </motion.aside>
        </div>
      </div>
    </main>
  );
}
