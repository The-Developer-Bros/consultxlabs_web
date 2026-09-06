"use client";

import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { HOW_IT_WORKS } from "./data";
import { SectionIntro, reveal, staggerDelay } from "./SectionIntro";

export function HowItWorksSection() {
  return (
    <section
      id="how-it-works"
      className="scroll-mt-20 bg-background py-20 md:py-28"
    >
      <div className="container mx-auto px-4 md:px-6">
        <div className="grid items-start gap-12 lg:grid-cols-[1fr_1.3fr] lg:gap-20">
          <div className="lg:sticky lg:top-28">
            <SectionIntro
              eyebrow="Getting started"
              title="How it works"
              lede="Four steps from a question you cannot answer alone to an hour with someone who can."
            />
            <Button
              size="lg"
              className="group h-12 rounded-xl px-6 text-base"
              asChild
            >
              <Link href="/explore/experts">
                Find an expert
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {HOW_IT_WORKS.map((step, index) => (
              <motion.div
                key={step.step}
                {...reveal(staggerDelay(index))}
                className="rounded-2xl border border-border bg-card p-6 shadow-elevation-1"
              >
                <span className="text-3xl font-semibold tabular-nums text-muted-foreground/50">
                  {String(step.step).padStart(2, "0")}
                </span>
                <h3 className="mt-4 text-lg font-semibold tracking-tight text-foreground">
                  {step.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {step.description}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
