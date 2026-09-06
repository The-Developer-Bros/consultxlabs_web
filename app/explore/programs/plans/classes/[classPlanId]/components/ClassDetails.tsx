"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Calendar, Clock, GraduationCap, Users } from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";

import { Badge } from "@/components/ui/badge";
import { PlanDetailBody } from "../../../components/PlanDetailBody";
import { PlanExpertCard } from "../../../components/PlanExpertCard";
import { PlanHero } from "../../../components/PlanHero";
import { FeatureItem } from "../../../components/FeatureItem";
import { planLevelLabel } from "@/lib/labels/plan-labels";
import {
  buildSessionsFromAppointments,
  groupSessionsByWeek,
  type SessionStatus,
} from "@/app/explore/programs/plans/schedule-utils";
import { ClientClassRegistration } from "./ClientClassRegistration";
import { useCurrency } from "@/hooks/useCurrency";
import { cn } from "@/utils/tailwind";
import type { TClassPlanDetailsData } from "../types";

const EASE = [0.16, 1, 0.3, 1] as const;

// A session's state is a real status, so it is the one place on this page
// that uses a semantic colour: a live session reads as success, a finished
// one fades back.
const STATUS_VARIANT: Record<
  SessionStatus,
  "success" | "secondary" | "outline"
> = {
  "Happening Now": "success",
  Upcoming: "secondary",
  Completed: "outline",
};

interface ClassDetailsProps {
  readonly plan: TClassPlanDetailsData;
}

export function ClassDetails({ plan }: ClassDetailsProps) {
  const { formatPrice } = useCurrency();
  const [userTimeZone, setUserTimeZone] = useState("UTC");
  useEffect(() => {
    setUserTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  const consultant = plan.consultantProfile;
  const months = plan.durationInMonths;
  const monthsLabel = `${months} month${months !== 1 ? "s" : ""}`;
  const batches = plan.classes ?? [];

  return (
    <main className="min-h-screen bg-background">
      <PlanHero
        backHref="/explore/programs"
        backLabel="Back to programs"
        kind="Class"
        title={plan.title}
        subtitle={plan.subtitle}
        price={formatPrice(plan.price)}
        priceNote={`for ${monthsLabel}`}
        imageUrl={plan.imageUrl}
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
                icon={<Calendar />}
                label="Duration"
                value={monthsLabel}
              />
              <FeatureItem
                icon={<Clock />}
                label="Per week"
                value={`${plan.sessionsPerWeek} session${plan.sessionsPerWeek !== 1 ? "s" : ""}`}
              />
              <FeatureItem
                icon={<Users />}
                label="Seats"
                value={`Up to ${plan.maxParticipants}`}
              />
              <FeatureItem
                icon={<GraduationCap />}
                label="Level"
                value={planLevelLabel(plan.level)}
              />
            </div>

            {/* Everything between the facts grid and the schedule is the
                shared body — see PlanDetailBody for why these four pages
                stopped each owning a copy. */}
            <PlanDetailBody
              aboutHeading="About this class"
              description={plan.description}
              learningOutcomes={plan.learningOutcomes}
              targetAudience={plan.targetAudience}
              whatsIncluded={plan.whatsIncluded}
              curriculum={plan.classContents}
              curriculumHeading="Course content"
              prerequisites={plan.prerequisites}
              materialProvided={plan.materialProvided}
              faqs={plan.faqs}
              topics={plan.topics}
            />

            <section className="rounded-2xl border border-border bg-card p-6 md:p-8">
              <h2 className="mb-5 text-lg font-semibold tracking-tight text-foreground">
                Schedule
              </h2>
              {batches.length > 0 ? (
                <div className="divide-y divide-border">
                  {batches.map((classInstance, classIndex) => {
                    const sessions = buildSessionsFromAppointments(
                      classInstance.appointments ?? [],
                    );
                    const weeks = groupSessionsByWeek(sessions);

                    return (
                      <div
                        key={classInstance.id}
                        className="space-y-5 py-6 first:pt-0 last:pb-0"
                      >
                        {batches.length > 1 && (
                          <h3 className="text-sm font-semibold text-foreground">
                            Batch {classIndex + 1}
                          </h3>
                        )}
                        {sessions.length > 0 ? (
                          Array.from(weeks.entries()).map(
                            ([weekNum, weekSessions]) => (
                              <div key={weekNum}>
                                <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                                  Week {weekNum}
                                </p>
                                <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                                  {weekSessions.map((session) => (
                                    <li
                                      key={session.appointmentId}
                                      className={cn(
                                        "flex items-center justify-between gap-4 px-4 py-3",
                                        session.status === "Completed" &&
                                          "opacity-60",
                                      )}
                                    >
                                      <div className="flex min-w-0 items-center gap-3">
                                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums text-foreground">
                                          {session.sessionNumber}
                                        </span>
                                        <p className="min-w-0 text-sm">
                                          <span className="font-medium text-foreground">
                                            {formatInTimeZone(
                                              session.sessionStart,
                                              userTimeZone,
                                              "EEEE, MMMM d",
                                            )}
                                          </span>
                                          <span className="ml-2 text-muted-foreground">
                                            {formatInTimeZone(
                                              session.sessionStart,
                                              userTimeZone,
                                              "h:mm a",
                                            )}
                                            {" – "}
                                            {formatInTimeZone(
                                              session.sessionEnd,
                                              userTimeZone,
                                              "h:mm a zzz",
                                            )}
                                          </span>
                                        </p>
                                      </div>
                                      <Badge
                                        variant={STATUS_VARIANT[session.status]}
                                        className="shrink-0"
                                      >
                                        {session.status}
                                      </Badge>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ),
                          )
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            Schedule to be announced
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Class schedule to be announced.
                </p>
              )}
            </section>
          </motion.div>

          <motion.aside
            className="space-y-4 lg:sticky lg:top-[calc(var(--header-height,5rem)+1rem)] lg:self-start"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
          >
            <ClientClassRegistration
              plan={plan}
              maxParticipants={plan.maxParticipants ?? undefined}
              consultantUserId={plan.consultantProfile?.user?.id}
            />
            <PlanExpertCard
              heading="Your instructor"
              expert={consultant}
              collaboratorsHeading="Co-instructors"
              collaborators={plan.collaborators}
            />
          </motion.aside>
        </div>
      </div>
    </main>
  );
}
