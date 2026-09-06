"use client";

import type { ReactNode } from "react";
import { motion } from "framer-motion";
import Link from "next/link";

import { cn } from "@/utils/tailwind";

/** The one reveal used across the landing page. Kept as a factory so a child
 *  index can stagger without every call site restating the curve. */
const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];

export function reveal(delay = 0) {
  return {
    initial: { opacity: 0, y: 16 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true, margin: "-80px" },
    transition: { duration: 0.5, ease: EASE, delay },
  };
}

/** Stagger for a list of siblings, capped so a long grid never crawls. */
export function staggerDelay(index: number) {
  return Math.min(index * 0.05, 0.3);
}

interface SectionIntroProps {
  eyebrow: string;
  title: ReactNode;
  lede?: ReactNode;
  action?: { label: string; href: string };
  tone?: "light" | "dark";
  align?: "left" | "center";
}

/** Eyebrow → h2 → lede, with an optional action link that sits on the same row
 *  from md up. Every section uses this so the intros are identical. */
export function SectionIntro({
  eyebrow,
  title,
  lede,
  action,
  tone = "light",
  align = "left",
}: SectionIntroProps) {
  const isDark = tone === "dark";
  const isCentered = align === "center";

  return (
    <motion.div
      {...reveal()}
      className={cn(
        "mb-10 flex flex-col gap-6 md:mb-14",
        isCentered
          ? "items-center text-center"
          : "md:flex-row md:items-end md:justify-between",
      )}
    >
      <div className="max-w-2xl">
        <p
          className={cn(
            "text-xs font-medium uppercase tracking-[0.18em]",
            isDark ? "text-zinc-500" : "text-muted-foreground",
          )}
        >
          {eyebrow}
        </p>
        <h2
          className={cn(
            "mt-3 text-fluid-3xl font-semibold tracking-[-0.02em] md:text-fluid-4xl",
            isDark ? "text-white" : "text-foreground",
          )}
        >
          {title}
        </h2>
        {lede ? (
          <p
            className={cn(
              "mt-4 max-w-2xl text-base leading-relaxed md:text-lg",
              isDark ? "text-zinc-400" : "text-muted-foreground",
            )}
          >
            {lede}
          </p>
        ) : null}
      </div>
      {action ? (
        <Link
          href={action.href}
          className={cn(
            "shrink-0 text-sm font-medium underline-offset-4 hover:underline",
            isDark ? "text-white" : "text-foreground",
          )}
        >
          {action.label}
        </Link>
      ) : null}
    </motion.div>
  );
}
