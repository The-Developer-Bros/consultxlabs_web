"use client";

import { ClassPlan, WebinarPlan } from "@prisma/client";
import { GraduationCap, BookOpen, Video } from "lucide-react";
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

  const renderPrograms = (programs: (ClassPlanProgram | WebinarPlanProgram)[]) =>
    programs.length > RAIL_THRESHOLD ? (
      <ProgramRow programs={programs} />
    ) : (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 sm:gap-6 lg:gap-8">
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

  return (
    <div>
      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        {/* Header with Tabs */}
        <div className="border-b border-border px-6 md:px-8 py-5">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
                <GraduationCap className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  Programs by this Expert
                </h2>
                <p className="text-sm text-muted-foreground">
                  {classPlans.length} class{classPlans.length !== 1 ? "es" : ""}{" "}
                  • {webinarPlans.length} webinar
                  {webinarPlans.length !== 1 ? "s" : ""}
                </p>
              </div>
            </div>

            {hasClasses && hasWebinars && (
              <div className="flex bg-muted rounded-xl p-1">
                {tabs.map(({ key, label, icon: Icon, count }) => (
                  <button
                    key={key}
                    onClick={() => setActiveTab(key)}
                    className={`relative px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                      activeTab === key
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {activeTab === key && (
                      <motion.div
                        layoutId="activeTab"
                        className="absolute inset-0 bg-card rounded-lg shadow-sm"
                        transition={{
                          type: "spring",
                          bounce: 0.2,
                          duration: 0.4,
                        }}
                      />
                    )}
                    <span className="relative flex items-center gap-2">
                      <Icon className="w-4 h-4" />
                      {label} ({count})
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="p-6 md:p-8">
          <AnimatePresence mode="wait">
            {activeTab === "classes" && hasClasses && (
              <motion.div
                key="classes"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.3 }}
              >
                {renderPrograms(classPrograms)}
              </motion.div>
            )}

            {activeTab === "webinars" && hasWebinars && (
              <motion.div
                key="webinars"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.3 }}
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
                className="text-center py-12"
              >
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-muted flex items-center justify-center">
                  {activeTab === "classes" ? (
                    <BookOpen className="w-8 h-8 text-muted-foreground/70" />
                  ) : (
                    <Video className="w-8 h-8 text-muted-foreground/70" />
                  )}
                </div>
                <p className="text-muted-foreground">
                  No {activeTab === "classes" ? "classes" : "webinars"}{" "}
                  available yet
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};
