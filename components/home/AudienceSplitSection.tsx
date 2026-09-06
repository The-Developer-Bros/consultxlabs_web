"use client";

import { motion } from "framer-motion";
import { ArrowRight, Clock, Mic, Target } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { ENTERPRISE_FEATURES } from "./data";
import { SectionIntro, reveal } from "./SectionIntro";

const EXPERT_BENEFITS = [
  { icon: Target, label: "Set your rates" },
  { icon: Clock, label: "Flexible schedule" },
  { icon: Mic, label: "Build your brand" },
];

/**
 * The two "which side are you on?" paths sit in one row at the page's end: the
 * organisation buyer (sponsored bookings, procurement invoicing, hosted expert
 * networks) and the supply side. They used to be two full-width bands.
 */
export function AudienceSplitSection() {
  return (
    <section className="bg-muted/40 py-20 md:py-28">
      <div className="container mx-auto px-4 md:px-6">
        <SectionIntro eyebrow="Join" title="Two more ways in" />

        <div className="grid gap-4 lg:grid-cols-2">
          <motion.div
            {...reveal()}
            className="rounded-2xl bg-zinc-950 p-8 text-white md:p-10"
          >
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
              For teams &amp; organisations
            </p>
            <h3 className="mt-3 text-2xl font-semibold tracking-tight">
              Bring Familiarise to your whole team
            </h3>
            <p className="mt-4 text-base leading-relaxed text-zinc-400">
              Sponsor sessions for your people, run structured mentorship
              programs, or host your own experts — with the billing and
              compliance your finance team expects.
            </p>

            <div className="mt-8 grid gap-x-6 gap-y-5 sm:grid-cols-2">
              {ENTERPRISE_FEATURES.map((feature) => {
                const Icon = feature.icon;
                return (
                  <div key={feature.title} className="flex gap-3">
                    <Icon
                      className="h-4 w-4 shrink-0 text-zinc-400"
                      strokeWidth={1.75}
                    />
                    <div className="min-w-0">
                      <h4 className="text-sm font-semibold">{feature.title}</h4>
                      <p className="mt-1 text-sm leading-relaxed text-zinc-400">
                        {feature.description}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button
                size="lg"
                className="group h-12 w-full rounded-xl bg-white px-6 text-base text-zinc-950 hover:bg-zinc-200 sm:w-auto"
                asChild
              >
                <Link href="/enterprise">
                  Explore Enterprise
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="h-12 w-full rounded-xl border-white/15 bg-transparent px-6 text-base text-white hover:bg-white/10 hover:text-white sm:w-auto"
                asChild
              >
                <Link href="/explore/enterprise/organisations">
                  Browse organisations
                </Link>
              </Button>
            </div>
          </motion.div>

          <motion.div
            {...reveal(0.05)}
            className="rounded-2xl border border-border bg-card p-8 shadow-elevation-1 md:p-10"
          >
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              For experts
            </p>
            <h3 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
              Share what you know, on your terms
            </h3>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground">
              Publish the hours you actually have, set your own price, and get
              paid for the advice you already give away.
            </p>

            <ul className="mt-8 divide-y divide-border border-y border-border">
              {EXPERT_BENEFITS.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.label} className="flex items-center gap-3 py-4">
                    <Icon
                      className="h-5 w-5 shrink-0 text-foreground"
                      strokeWidth={1.75}
                    />
                    <span className="text-sm font-medium text-foreground">
                      {item.label}
                    </span>
                  </li>
                );
              })}
            </ul>

            <Button
              size="lg"
              className="group mt-8 h-12 w-full rounded-xl px-6 text-base sm:w-auto"
              asChild
            >
              <Link href="/become-an-expert">
                Apply as an expert
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </Button>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
