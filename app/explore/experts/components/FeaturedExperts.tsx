"use client";

import { memo } from "react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import Link from "next/link";
import { motion } from "framer-motion";
import { User, Star, BadgeCheck } from "lucide-react";
import { CompanyLogo } from "@/components/ui/company-logo";
import type { IConsultantCardData } from "@/types/consultant";

interface FeaturedExpertsProps {
  experts: IConsultantCardData[];
  isLoading: boolean;
}

const REVEAL = {
  initial: { opacity: 0, y: 16 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-80px" },
} as const;

function FeaturedExpertsImpl({ experts, isLoading }: FeaturedExpertsProps) {
  // Nothing to feature is a real state before launch — a heading over an empty
  // grid is worse than no band at all.
  if (!isLoading && experts.length === 0) return null;

  return (
    <section className="border-b border-border bg-muted/40 py-16 md:py-20">
      <div className="mx-auto max-w-[1600px] px-4 md:px-8 lg:px-12">
        <motion.div
          className="mb-10 md:mb-14"
          {...REVEAL}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        >
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Familiarise picks
          </p>
          <h2 className="mt-3 text-fluid-3xl font-semibold tracking-[-0.02em] text-foreground md:text-fluid-4xl">
            Top rated experts
          </h2>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground md:text-lg">
            The highest-rated verified experts on the platform right now.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {isLoading
            ? Array.from({ length: 5 }).map((_, index) => (
                <div
                  key={index}
                  className="animate-pulse rounded-2xl border border-border bg-card p-5"
                >
                  <div className="flex items-center gap-3">
                    <div className="h-14 w-14 shrink-0 rounded-full bg-muted" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="h-4 w-3/4 rounded bg-muted" />
                      <div className="h-3 w-1/2 rounded bg-muted" />
                    </div>
                  </div>
                  <div className="mt-4 h-3 w-24 rounded bg-muted" />
                  <div className="mt-6 h-4 w-full rounded bg-muted" />
                </div>
              ))
            : experts.map((expert, index) => (
                <motion.div
                  key={expert.id}
                  className="h-full"
                  {...REVEAL}
                  transition={{
                    duration: 0.5,
                    ease: [0.16, 1, 0.3, 1],
                    delay: Math.min(index * 0.05, 0.3),
                  }}
                >
                  <Link
                    href={`/explore/experts/${expert.id}`}
                    className="group flex h-full flex-col gap-4 rounded-2xl border border-border bg-card p-5 shadow-elevation-1 transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-elevation-2"
                  >
                    <div className="flex items-center gap-3">
                      <Avatar className="h-14 w-14 shrink-0 ring-1 ring-border">
                        <AvatarImage
                          src={expert.user.image || "/placeholder-user.jpg"}
                          alt={expert.user.name || "Expert"}
                          className="object-cover"
                        />
                        <AvatarFallback className="bg-muted text-muted-foreground">
                          <User className="h-6 w-6" />
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <h3 className="line-clamp-1 font-semibold text-foreground">
                            {expert.user.name}
                          </h3>
                          {expert.isVerified && (
                            <span
                              title="Verified by Familiarise"
                              className="shrink-0"
                            >
                              <BadgeCheck className="h-4 w-4 text-foreground" />
                            </span>
                          )}
                        </div>
                        {(expert.headline || expert.domain?.name) && (
                          <p className="line-clamp-1 text-sm text-muted-foreground">
                            {expert.headline || expert.domain?.name}
                          </p>
                        )}
                      </div>
                    </div>

                    {(expert.rating !== null || expert.experience) && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        {expert.rating !== null && (
                          <span className="inline-flex items-center gap-1">
                            <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                            <span className="font-medium tabular-nums text-foreground">
                              {expert.rating.toFixed(1)}
                            </span>
                          </span>
                        )}
                        {expert.rating !== null && expert.experience ? (
                          <span aria-hidden>·</span>
                        ) : null}
                        {expert.experience ? (
                          <span className="tabular-nums">
                            {expert.experience} yrs
                          </span>
                        ) : null}
                      </div>
                    )}

                    <div className="mt-auto flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {expert.user.workExperiences
                          ?.slice(0, 2)
                          .map((exp, i) => (
                            <CompanyLogo
                              key={`${expert.id}-company-${i}`}
                              companyName={exp.company}
                              companyDomain={exp.companyDomain ?? undefined}
                              size={22}
                              className="border-border"
                            />
                          ))}
                        {expert.tags?.[0] && (
                          <span className="inline-flex min-w-0 items-center rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground">
                            <span className="truncate">
                              {expert.tags[0].name}
                            </span>
                          </span>
                        )}
                      </div>
                      <span className="shrink-0 text-sm font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                        View profile →
                      </span>
                    </div>
                  </Link>
                </motion.div>
              ))}
        </div>
      </div>
    </section>
  );
}

export const FeaturedExperts = memo(FeaturedExpertsImpl);
