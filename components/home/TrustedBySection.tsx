"use client";

import { motion } from "framer-motion";

import { COMPANY_LOGOS } from "./data";
import { reveal } from "./SectionIntro";

export function TrustedBySection() {
  return (
    <section className="border-b border-border bg-background py-10">
      <div className="container mx-auto px-4 md:px-6">
        <motion.div
          {...reveal()}
          className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between md:gap-12"
        >
          <p className="shrink-0 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Our experts have worked at
          </p>
          <div className="flex flex-wrap gap-x-10 gap-y-4">
            {COMPANY_LOGOS.map((company) => (
              <span
                key={company}
                className="text-base font-semibold tracking-tight text-zinc-400"
              >
                {company}
              </span>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}
