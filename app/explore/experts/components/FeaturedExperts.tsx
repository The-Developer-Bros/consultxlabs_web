"use client";

import { memo } from "react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { motion } from "framer-motion";
import { User, Star, StarHalf, ArrowRight, Award, BadgeCheck, Globe } from "lucide-react";
import { CompanyLogo } from "@/components/ui/company-logo";
import type { IConsultantCardData } from "@/types/consultant";

interface FeaturedExpertsProps {
  experts: IConsultantCardData[];
  isLoading: boolean;
}

function FeaturedExpertsImpl({ experts, isLoading }: FeaturedExpertsProps) {
  const renderRating = (rating: number) => {
    const fullStars = Math.floor(rating);
    const hasHalfStar = rating % 1 >= 0.5;

    return (
      <div className="flex items-center gap-1">
        {[...Array(fullStars)].map((_, i) => (
          <Star key={i} className="w-4 h-4 fill-amber-400 text-amber-400" />
        ))}
        {hasHalfStar && (
          <StarHalf className="w-4 h-4 fill-amber-400 text-amber-400" />
        )}
        <span className="text-sm font-medium text-muted-foreground ml-1">
          {rating.toFixed(1)}
        </span>
      </div>
    );
  };

  return (
    <section className="py-20 bg-gradient-to-b from-zinc-100 to-white relative overflow-hidden">
      {/* Background Pattern */}
      <div className="absolute inset-0 dot-pattern opacity-30" />

      <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 relative z-10">
        {/* Section Header */}
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-primary rounded-full mb-6">
            <Award className="w-4 h-4 text-primary-foreground" />
            <span className="text-sm font-medium text-primary-foreground">
              Familiarise Pick
            </span>
          </div>
          <h2 className="text-fluid-3xl md:text-fluid-4xl font-bold tracking-tight text-foreground mb-4">
            Top Familiarise <span className="silver-text">Experts</span>
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Discover the best of the best. Our top consultants are ready to help
            you achieve your goals.
          </p>
        </motion.div>

        {/* Experts Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-6">
          {isLoading
            ? Array(5)
                .fill(0)
                .map((_, index) => (
                  <div
                    key={index}
                    className="bg-card rounded-2xl p-6 shadow-sm border border-border animate-pulse"
                  >
                    <div className="w-20 h-20 rounded-full bg-muted mx-auto mb-4" />
                    <div className="h-5 bg-muted rounded w-3/4 mx-auto mb-3" />
                    <div className="h-4 bg-muted rounded w-1/2 mx-auto mb-4" />
                    <div className="flex gap-2 justify-center">
                      <div className="h-6 bg-muted rounded-full w-16" />
                      <div className="h-6 bg-muted rounded-full w-16" />
                    </div>
                  </div>
                ))
            : experts.map((expert, index) => (
                <motion.div
                  key={expert.id}
                  className="h-full"
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{
                    duration: 0.4,
                    delay: Math.min(index * 0.1, 0.6),
                  }}
                >
                  <Link
                    href={`/explore/experts/${expert.id}`}
                    className="group block h-full"
                  >
                    <div className="bg-card rounded-2xl p-6 shadow-sm border border-border hover:border-border hover:shadow-lg transition-all duration-300 h-full flex flex-col">
                      {/* Avatar */}
                      <div className="relative mb-4">
                        <Avatar className="mx-auto h-20 w-20 ring-4 ring-muted group-hover:ring-border transition-all">
                          <AvatarImage
                            src={expert.user.image || "/placeholder-user.jpg"}
                            alt={expert.user.name || "Expert"}
                            className="object-cover"
                          />
                          <AvatarFallback className="bg-primary text-primary-foreground">
                            <User className="h-10 w-10" />
                          </AvatarFallback>
                        </Avatar>
                        {/* Top Expert Badge */}
                        {index === 0 && (
                          <div className="absolute -top-2 -right-2 w-8 h-8 bg-gradient-to-br from-amber-400 to-amber-600 rounded-full flex items-center justify-center shadow-lg">
                            <Award className="w-4 h-4 text-white" />
                          </div>
                        )}
                      </div>

                      {/* Name */}
                      <div className="flex items-center justify-center gap-1 mb-2">
                        <h3 className="text-lg font-semibold text-foreground text-center line-clamp-1 group-hover:text-muted-foreground transition-colors">
                          {expert.user.name}
                        </h3>
                        {expert.isVerified && (
                          <span title="Verified by Familiarise">
                            <BadgeCheck className="w-4 h-4 text-foreground flex-shrink-0" />
                          </span>
                        )}
                      </div>

                      {/* Rating */}
                      <div className="flex justify-center mb-3">
                        {expert.rating !== null && renderRating(expert.rating)}
                      </div>

                      {/* Headline */}
                      <div className="text-center">
                        <p className="text-sm text-muted-foreground font-medium line-clamp-1 mb-1">
                          {expert.headline || expert.domain?.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {expert.experience} experience
                        </p>
                      </div>

                      {/* Bottom section — pinned to bottom for consistent card height */}
                      <div className="mt-auto pt-3">
                        {/* Company Logos */}
                        {expert.user.workExperiences &&
                          expert.user.workExperiences.length > 0 && (
                            <div className="flex items-center justify-center gap-1.5 mb-3">
                              {expert.user.workExperiences
                                .slice(0, 2)
                                .map((exp, i) => (
                                  <CompanyLogo
                                    key={`${expert.id}-company-${i}`}
                                    companyName={exp.company}
                                    companyDomain={exp.companyDomain ?? undefined}
                                    size={22}
                                    className="border-border"
                                  />
                                ))}
                            </div>
                          )}

                        {/* Languages */}
                        {expert.languages && expert.languages.length > 0 && (
                          <div className="flex items-center justify-center gap-1 mb-3">
                            <Globe className="w-3 h-3 text-muted-foreground/70 flex-shrink-0" />
                            <p className="text-xs text-muted-foreground line-clamp-1">
                              {expert.languages.slice(0, 3).join(", ")}
                            </p>
                          </div>
                        )}

                        {/* Tags */}
                        {expert.tags && expert.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 justify-center mb-3">
                            {expert.tags.slice(0, 2).map((tag) => (
                              <Badge
                                key={tag.id}
                                className="text-xs px-2 py-0.5 bg-muted text-muted-foreground hover:bg-muted/80 border-0"
                              >
                                {tag.name}
                              </Badge>
                            ))}
                          </div>
                        )}

                        {/* View Profile */}
                        <div className="flex items-center justify-center gap-1 text-sm font-medium text-muted-foreground group-hover:text-foreground transition-colors">
                          <span>View Profile</span>
                          <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                        </div>
                      </div>
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
