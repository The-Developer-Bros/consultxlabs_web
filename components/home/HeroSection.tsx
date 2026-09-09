"use client";

import { useCallback } from "react";
import { motion, useInView } from "framer-motion";
import { ArrowRight, Sparkles } from "lucide-react";
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
      className="text-4xl md:text-5xl font-bold text-white tabular-nums"
    >
      {value % 1 !== 0
        ? displayValue.toFixed(1)
        : displayValue.toLocaleString()}
      {suffix}
    </motion.span>
  );
}

export function HeroSection({
  stats,
}: {
  stats: IPublicStat<ExpertStatKey>[];
}) {
  return (
    <section className="relative min-h-[95vh] flex items-center bg-black overflow-hidden">
      {/* Animated gradient orbs */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-1/4 left-1/4 w-[600px] h-[600px] rounded-full bg-gradient-to-br from-zinc-800/50 to-transparent blur-[50px] animate-blob" />
        <div className="absolute top-1/3 right-1/4 w-[500px] h-[500px] rounded-full bg-gradient-to-bl from-zinc-700/30 to-transparent blur-[50px] animate-blob animation-delay-2000" />
        <div className="absolute bottom-1/4 left-1/2 w-[700px] h-[700px] rounded-full bg-gradient-to-t from-zinc-800/40 to-transparent blur-[50px] animate-blob animation-delay-4000" />
      </div>

      {/* Grid pattern overlay */}
      <div className="absolute inset-0 grid-pattern opacity-30" />

      {/* Spotlight effect */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] bg-gradient-to-b from-zinc-800/20 via-transparent to-transparent blur-[40px]" />

      <div className="container mx-auto px-4 md:px-6 relative z-10 py-20 md:py-32">
        <div className="max-w-4xl mx-auto text-center">
          {/* Badge */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 backdrop-blur-sm border border-white/10 text-zinc-400 text-sm mb-8"
          >
            <Sparkles className="w-4 h-4 text-zinc-300" />
            {/* #1490 — was "Trusted by 10,000+ professionals worldwide", a
                number nothing produced. What replaces it is enforced by the
                directory reads themselves: only VERIFIED profiles are public. */}
            <span>Every expert is verified before they are listed</span>
          </motion.div>

          {/* Main headline */}
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="text-fluid-5xl font-bold text-white mb-6 leading-tight tracking-tight"
          >
            Learn from the{" "}
            <span className="relative inline-block">
              <span className="silver-text">best minds</span>
            </span>
            <br />
            <span className="text-zinc-400">in your industry</span>
          </motion.h1>

          {/* Subheadline */}
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="text-lg md:text-xl text-zinc-500 mb-10 max-w-2xl mx-auto leading-relaxed"
          >
            Connect with world-class experts for personalized 1-on-1 sessions,
            interactive classes, and live webinars. Your career transformation
            starts here.
          </motion.p>

          {/* CTAs */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16"
          >
            <Button
              size="lg"
              className="bg-white text-black hover:bg-zinc-200 px-8 h-14 text-base rounded-xl shadow-lg shadow-white/10 group font-medium"
              asChild
            >
              <Link href="/explore/experts">
                Find Your Expert
                <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </Link>
            </Button>
            {/* The supply-side CTA lives here now that the navbar carries no
                CTAs. (It replaces a "Watch Demo" button that had no href and
                no handler — it did nothing when clicked.) */}
            <Button
              size="lg"
              variant="outline"
              className="border-zinc-700 bg-transparent text-white hover:bg-zinc-900 hover:text-white px-8 h-14 text-base rounded-xl group"
              asChild
            >
              <Link href="/become-an-expert">
                Become an Expert
                <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
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
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.4 }}
              className="grid grid-cols-2 md:grid-cols-3 gap-8 md:gap-12 pt-8 border-t border-zinc-800"
            >
              {stats.map((stat) => (
                <div key={stat.key} className="text-center">
                  <AnimatedNumber value={stat.value} />
                  <div className="text-zinc-600 text-sm mt-1">{stat.label}</div>
                </div>
              ))}
            </motion.div>
          )}
        </div>
      </div>

      {/* Bottom gradient fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-zinc-950 to-transparent" />
    </section>
  );
}
