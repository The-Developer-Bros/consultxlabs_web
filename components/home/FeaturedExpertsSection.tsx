"use client";

import { motion } from "framer-motion";
import { ChevronRight, Star } from "lucide-react";
import Link from "next/link";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { IConsultantCardData } from "@/types/consultant";

function ExpertCard({ expert }: { expert: IConsultantCardData }) {
  return (
    <Link
      href={`/explore/experts/${expert.id}`}
      className="block flex-shrink-0 w-[300px] mx-3"
    >
      <Card className="h-full border border-border bg-card overflow-hidden group hover:border-foreground/30 transition-all duration-300 hover:-translate-y-1 hover:shadow-elevation-3">
        <CardContent className="p-6">
          <div className="flex items-center gap-4 mb-4">
            <Avatar className="w-16 h-16 border-2 border-border shadow-elevation-2">
              <AvatarImage
                src={expert.user.image ?? "/placeholder-user.jpg"}
                alt={expert.user.name ?? "Expert"}
              />
              <AvatarFallback className="bg-gradient-to-br from-zinc-700 to-zinc-900 text-white text-lg font-medium">
                {expert.user.name?.charAt(0) ?? "E"}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <h4 className="font-semibold text-foreground truncate">
                {expert.user.name}
              </h4>
              <p className="text-sm text-muted-foreground truncate">
                {expert.headline || expert.domain?.name}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 mb-4">
            {expert.rating !== null && (
              <>
                <div className="flex items-center gap-1">
                  <Star className="w-4 h-4 fill-foreground text-foreground" />
                  <span className="font-medium text-foreground">
                    {expert.rating.toFixed(1)}
                  </span>
                </div>
                <span className="text-muted-foreground/70">•</span>
              </>
            )}
            <span className="text-sm text-muted-foreground">
              {expert.experience}
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            {expert.tags?.slice(0, 3).map((tag) => (
              <Badge
                key={tag.id}
                variant="secondary"
                className="bg-secondary text-secondary-foreground hover:bg-secondary/80 text-xs border-0"
              >
                {tag.name}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function ExpertLoadingSkeleton() {
  return (
    <div className="flex-shrink-0 w-[300px] mx-3">
      <Card className="h-[200px] animate-pulse bg-muted border-0" />
    </div>
  );
}

interface FeaturedExpertsSectionProps {
  experts: IConsultantCardData[];
  isLoading: boolean;
}

export function FeaturedExpertsSection({
  experts,
  isLoading,
}: FeaturedExpertsSectionProps) {
  return (
    <section className="py-20 md:py-32 bg-background overflow-hidden relative">
      <div className="absolute inset-0 dot-pattern-light opacity-60" />

      <div className="container mx-auto px-4 md:px-6 mb-12 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          viewport={{ once: true }}
          className="flex flex-col md:flex-row md:items-end md:justify-between gap-6"
        >
          <div>
            <Badge
              variant="secondary"
              className="mb-4 bg-secondary text-secondary-foreground hover:bg-secondary border-0"
            >
              Featured Experts
            </Badge>
            <h2 className="text-fluid-4xl font-bold text-foreground mb-2 tracking-tight">
              Learn from{" "}
              <span className="text-muted-foreground">industry leaders</span>
            </h2>
            <p className="text-lg text-muted-foreground">
              Handpicked professionals ready to guide your journey
            </p>
          </div>
          <Link href="/explore/experts">
            <Button
              variant="outline"
              className="group border-border hover:bg-muted"
            >
              View All Experts
              <ChevronRight className="ml-1 w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </Button>
          </Link>
        </motion.div>
      </div>

      {/* Marquee */}
      <div className="relative">
        <div className="absolute left-0 top-0 bottom-0 w-32 bg-gradient-to-r from-background to-transparent z-10" />
        <div className="absolute right-0 top-0 bottom-0 w-32 bg-gradient-to-l from-background to-transparent z-10" />

        <div className="flex animate-marquee">
          {isLoading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <ExpertLoadingSkeleton key={i} />
            ))
          ) : (
            <>
              {[...experts, ...experts].map((expert, i) => (
                <ExpertCard key={`${expert.id}-${i}`} expert={expert} />
              ))}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
