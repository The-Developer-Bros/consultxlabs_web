"use client";

import { motion } from "framer-motion";
import Link from "next/link";

import { FEATURES, PLATFORM_FEATURES } from "./data";
import { SectionIntro, reveal, staggerDelay } from "./SectionIntro";

function FeatureCard({
  feature,
  index,
}: {
  feature: (typeof FEATURES)[number];
  index: number;
}) {
  const Icon = feature.icon;

  return (
    <motion.div {...reveal(staggerDelay(index))}>
      <Link
        href={feature.href}
        className="group flex h-full flex-col rounded-2xl border border-border bg-card p-6 shadow-elevation-1 transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-elevation-2"
      >
        <div className="flex items-start justify-between gap-4">
          <span className="text-xs font-medium tabular-nums text-muted-foreground">
            {String(index + 1).padStart(2, "0")}
          </span>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
            <Icon className="h-5 w-5" strokeWidth={1.75} />
          </div>
        </div>
        <h3 className="mt-6 text-lg font-semibold tracking-tight text-foreground">
          {feature.title}
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {feature.description}
        </p>
      </Link>
    </motion.div>
  );
}

export function FeaturesSection() {
  return (
    <section className="bg-background py-20 md:py-28">
      <div className="container mx-auto px-4 md:px-6">
        <SectionIntro
          eyebrow="Formats"
          title="Four ways to learn"
          lede="Pick the format that fits the problem: a single conversation, a mentorship over months, a cohort, or a live room."
        />

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((feature, index) => (
            <FeatureCard key={feature.title} feature={feature} index={index} />
          ))}
        </div>

        <div className="mt-12 border-t border-border pt-10">
          <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
            {PLATFORM_FEATURES.map((feature, index) => {
              const Icon = feature.icon;
              return (
                <motion.div
                  key={feature.title}
                  {...reveal(staggerDelay(index))}
                  className="flex gap-3"
                >
                  <Icon
                    className="h-5 w-5 shrink-0 text-foreground"
                    strokeWidth={1.75}
                  />
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-foreground">
                      {feature.title}
                    </h3>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      {feature.description}
                    </p>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
