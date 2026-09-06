"use client";

import { useCallback } from "react";
import { motion, useInView } from "framer-motion";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRef, useState, useEffect } from "react";

import { Button } from "@/components/ui/button";
import type { ExpertStatKey, IPublicStat } from "@/lib/data/public-stats";

function AnimatedNumber({
  value,
  suffix = "",
}: {
  value: number;
  suffix?: string;
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true });
  const [displayValue, setDisplayValue] = useState(0);

  const animate = useCallback(() => {
    const duration = 2000;
    const steps = 60;
    const increment = value / steps;
    let current = 0;
    const timer = setInterval(() => {
      current += increment;
      if (current >= value) {
        setDisplayValue(value);
        clearInterval(timer);
      } else {
        setDisplayValue(Math.floor(current));
      }
    }, duration / steps);
    return () => clearInterval(timer);
  }, [value]);

  useEffect(() => {
    if (isInView) {
      return animate();
    }
  }, [isInView, animate]);

  return (
    <motion.span
      ref={ref}
      className="text-3xl font-semibold tabular-nums text-white md:text-4xl"
    >
      {value % 1 !== 0
        ? displayValue.toFixed(1)
        : displayValue.toLocaleString()}
      {suffix}
    </motion.span>
  );
}

const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];

/** Above the fold, so this enters on mount rather than on scroll. */
function enter(delay: number) {
  return {
    initial: { opacity: 0, y: 16 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.5, ease: EASE, delay },
  };
}

export function HeroSection({
  stats,
}: {
  stats: IPublicStat<ExpertStatKey>[];
}) {
  return (
    <section className="relative flex min-h-[88svh] items-center overflow-hidden border-b border-white/10 bg-zinc-950">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(60%_50%_at_50%_0%,rgba(255,255,255,0.08),transparent)]"
      />

      <div className="container relative z-10 mx-auto px-4 py-24 md:px-6 md:py-32">
        <div className="mx-auto max-w-4xl text-center">
          <motion.div
            {...enter(0)}
            className="inline-flex items-center gap-2.5"
          >
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-white/60"
            />
            {/* #1490 — was "Trusted by 10,000+ professionals worldwide", a
                number nothing produced. What replaces it is enforced by the
                directory reads themselves: only VERIFIED profiles are public. */}
            <span className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-400">
              Every expert is verified before they are listed
            </span>
          </motion.div>

          <motion.h1
            {...enter(0.08)}
            className="mt-8 text-fluid-5xl font-semibold leading-[1.02] tracking-[-0.03em] text-white"
          >
            Learn from the best minds
            <br />
            <span className="text-zinc-400">in your industry</span>
          </motion.h1>

          <motion.p
            {...enter(0.16)}
            className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-zinc-400 md:text-lg"
          >
            Connect with world-class experts for personalized 1-on-1 sessions,
            interactive classes, and live webinars. Your career transformation
            starts here.
          </motion.p>

          <motion.div
            {...enter(0.24)}
            className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row"
          >
            <Button
              size="lg"
              className="group h-12 w-full rounded-xl bg-white px-6 text-base text-zinc-950 hover:bg-zinc-200 sm:w-auto"
              asChild
            >
              <Link href="/explore/experts">
                Find your expert
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </Button>
            {/* The supply-side CTA lives here now that the navbar carries no
                CTAs. (It replaces a "Watch Demo" button that had no href and
                no handler — it did nothing when clicked.) */}
            <Button
              size="lg"
              variant="outline"
              className="group h-12 w-full rounded-xl border-white/15 bg-transparent px-6 text-base text-white hover:bg-white/10 hover:text-white sm:w-auto"
              asChild
            >
              <Link href="/become-an-expert">
                Become an expert
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </Button>
          </motion.div>

          {/* Stats with animated counters. #1490 — every counter here is read
              from the database now, and a figure that is still zero produces no
              tile at all rather than a placeholder. With no data yet the whole
              row is absent, which is why it is rendered conditionally: an empty
              grid would leave a stray divider under the CTAs. */}
          {stats.length > 0 && (
            <motion.div
              {...enter(0.32)}
              className="mt-16 flex justify-center divide-x divide-white/10 border-t border-white/10 pt-10"
            >
              {stats.map((stat) => (
                <div
                  key={stat.key}
                  className="flex flex-col items-center px-6 text-center md:px-12"
                >
                  <AnimatedNumber value={stat.value} />
                  <span className="mt-2 text-xs uppercase tracking-[0.18em] text-zinc-500">
                    {stat.label}
                  </span>
                </div>
              ))}
            </motion.div>
          )}
        </div>
      </div>
    </section>
  );
}
