"use client";

import { ClassPlan, WebinarPlan } from "@prisma/client";
import { BookOpen, Video } from "lucide-react";
import React, { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

import ProgramCard from "@/app/explore/programs/components/ProgramCard";
import ProgramRow from "@/app/explore/programs/components/ProgramRow";
import {
  generateProgramImageUrl,
  type ClassPlanProgram,
  type WebinarPlanProgram,
} from "@/lib/explore/programs";

// price is number at runtime via the extended client (#780)
type ClassPlanRow = Omit<ClassPlan, "price"> & { price: number };
type WebinarPlanRow = Omit<WebinarPlan, "price"> & { price: number };

interface ClassesAndWebinarsProps {
  classPlans: ClassPlanRow[];
  webinarPlans: WebinarPlanRow[];
  enrolledClassPlanIds?: Set<string>;
  registeredWebinarPlanIds?: Set<string>;
}

/**
 * Past this many items a tab body switches from a grid to a horizontal rail.
 *
 * The grid used to render EVERY plan with no cap, so a consultant with fifteen
 * classes pushed reviews and availability several screens down. A rail keeps
 * the section a fixed height whatever the count; below the threshold a grid
 * still reads better than a rail with dead space beside it.
 */
const RAIL_THRESHOLD = 3;

export const ClassesAndWebinars: React.FC<ClassesAndWebinarsProps> = ({
  classPlans,
  webinarPlans,
  enrolledClassPlanIds = new Set(),
  registeredWebinarPlanIds = new Set(),
}) => {
  const [activeTab, setActiveTab] = useState<"classes" | "webinars">("classes");

  const hasClasses = classPlans.length > 0;
  const hasWebinars = webinarPlans.length > 0;
  const hasContent = hasClasses || hasWebinars;

  // Adapt the profile page's plan rows to the `Program` shape ProgramCard
  // consumes, so the card, its badges, price formatting and deep links stay
  // identical to /explore/programs instead of being re-implemented here.
  const classPrograms = useMemo<ClassPlanProgram[]>(
    () =>
      classPlans.map((plan) => ({
        ...plan,
        type: "class" as const,
        classes: [],
        imageUrl: generateProgramImageUrl(plan.id, 600, 400, plan.imageUrl),
        isRegistered: enrolledClassPlanIds.has(plan.id),
      })),
    [classPlans, enrolledClassPlanIds],
  );

  const webinarPrograms = useMemo<WebinarPlanProgram[]>(
    () =>
      webinarPlans.map((plan) => ({
        ...plan,
        type: "webinar" as const,
        webinars: [],
        imageUrl: generateProgramImageUrl(plan.id, 600, 400, plan.imageUrl),
        isRegistered: registeredWebinarPlanIds.has(plan.id),
      })),
    [webinarPlans, registeredWebinarPlanIds],
  );

  // Auto-select webinars if no classes
  React.useEffect(() => {
    if (!hasClasses && hasWebinars) {
      setActiveTab("webinars");
    }
  }, [hasClasses, hasWebinars]);

  if (!hasContent) {
    return null;
  }

  const renderPrograms = (
    programs: (ClassPlanProgram | WebinarPlanProgram)[],
  ) =>
    programs.length > RAIL_THRESHOLD ? (
      <ProgramRow programs={programs} />
    ) : (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {programs.map((program) => (
          <ProgramCard key={program.id} program={program} />
        ))}
      </div>
    );

  const tabs = [
    {
      key: "classes" as const,
      label: "Classes",
      icon: BookOpen,
      count: classPlans.length,
      show: hasClasses,
    },
    {
      key: "webinars" as const,
      label: "Webinars",
      icon: Video,
      count: webinarPlans.length,
      show: hasWebinars,
    },
  ];

  const summary = [
    hasClasses &&
      `${classPlans.length} class${classPlans.length !== 1 ? "es" : ""}`,
    hasWebinars &&
      `${webinarPlans.length} webinar${webinarPlans.length !== 1 ? "s" : ""}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-5 md:px-8">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            Programs by this expert
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{summary}</p>
        </div>

        {hasClasses && hasWebinars && (
          <div
            role="tablist"
            aria-label="Program type"
            className="inline-flex rounded-xl border border-border bg-muted/60 p-1"
          >
            {tabs.map(({ key, label, icon: Icon, count }) => (
              <button
                key={key}
                role="tab"
                aria-selected={activeTab === key}
                onClick={() => setActiveTab(key)}
                className={`relative rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
                  activeTab === key
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {activeTab === key && (
                  <motion.div
                    layoutId="activeTab"
                    className="absolute inset-0 rounded-lg bg-card shadow-elevation-1"
                    transition={{
                      type: "spring",
                      bounce: 0.2,
                      duration: 0.4,
                    }}
                  />
                )}
                <span className="relative flex items-center gap-1.5">
                  <Icon className="h-4 w-4" />
                  {label}
                  <span className="tabular-nums text-muted-foreground">
                    {count}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="p-6 md:p-8">
        <AnimatePresence mode="wait">
          {activeTab === "classes" && hasClasses && (
            <motion.div
              key="classes"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
            >
              {renderPrograms(classPrograms)}
            </motion.div>
          )}

          {activeTab === "webinars" && hasWebinars && (
            <motion.div
              key="webinars"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
            >
              {renderPrograms(webinarPrograms)}
            </motion.div>
          )}

          {/* Empty State */}
          {((activeTab === "classes" && !hasClasses) ||
            (activeTab === "webinars" && !hasWebinars)) && (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col items-center py-10 text-center"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-foreground">
                {activeTab === "classes" ? (
                  <BookOpen className="h-5 w-5" strokeWidth={1.75} />
                ) : (
                  <Video className="h-5 w-5" strokeWidth={1.75} />
                )}
              </div>
              <p className="mt-4 text-sm text-muted-foreground">
                No {activeTab === "classes" ? "classes" : "webinars"} available
                yet
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
};
