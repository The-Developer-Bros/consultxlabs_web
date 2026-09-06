"use client";

import { motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { CATEGORIES } from "./data";
import { SectionIntro, reveal, staggerDelay } from "./SectionIntro";

function CategoryCard({
  category,
  consultantCount,
  index,
}: {
  category: (typeof CATEGORIES)[number];
  /** Verified consultants in the domain of this name, or 0 when there is no
   *  such domain yet. Zero renders no line rather than "0 experts" (#1490). */
  consultantCount: number;
  index: number;
}) {
  const Icon = category.icon;

  return (
    <motion.div {...reveal(staggerDelay(index))}>
      <Link
        href={`/explore/experts?category=${category.name.toLowerCase()}`}
        className="group flex items-center gap-3 rounded-2xl border border-border bg-card p-4 shadow-elevation-1 transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-elevation-2"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-foreground">
          <Icon className="h-5 w-5" strokeWidth={1.75} />
        </div>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">
            {category.name}
          </h3>
          {consultantCount > 0 && (
            <p className="truncate text-xs text-muted-foreground">
              {consultantCount === 1
                ? "1 expert"
                : `${consultantCount} experts`}
            </p>
          )}
        </div>
        <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </Link>
    </motion.div>
  );
}

export function CategoriesSection({
  consultantsByDomain,
}: {
  /** Verified consultant counts keyed by lowercased domain name (#1490). */
  consultantsByDomain: Record<string, number>;
}) {
  return (
    <section className="bg-muted/40 py-20 md:py-28">
      <div className="container mx-auto px-4 md:px-6">
        <SectionIntro
          eyebrow="Categories"
          title="Browse by expertise"
          lede="Find the people who already work in your field, and start with the one whose day looks like the problem you have."
          action={{ label: "View all experts →", href: "/explore/experts" }}
        />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {CATEGORIES.map((category, index) => (
            <CategoryCard
              key={category.name}
              category={category}
              consultantCount={
                consultantsByDomain[category.name.toLowerCase()] ?? 0
              }
              index={index}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
