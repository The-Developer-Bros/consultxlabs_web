"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ArrowRight, Sparkles } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { CompanyLogo } from "@/components/ui/company-logo";
import { useCurrency } from "@/hooks/useCurrency";
import { isClassProgram, Program } from "@/lib/explore/programs";

interface FeaturedCarouselProps {
  programs: Program[];
  isLoading?: boolean;
}

function SkeletonSlide() {
  return (
    <div className="flex-shrink-0 w-full rounded-2xl overflow-hidden border border-border bg-muted animate-pulse">
      <div className="flex flex-col md:flex-row h-[320px] md:h-[280px]">
        <div className="md:w-[400px] bg-muted flex-shrink-0 h-[160px] md:h-full" />
        <div className="flex-1 p-6 md:p-8 space-y-4">
          <div className="h-4 bg-muted rounded w-20" />
          <div className="h-7 bg-muted rounded w-3/4" />
          <div className="h-4 bg-muted rounded w-full" />
          <div className="h-4 bg-muted rounded w-2/3" />
          <div className="h-10 bg-muted rounded w-32 mt-4" />
        </div>
      </div>
    </div>
  );
}

function FeaturedCarouselImpl({
  programs,
  isLoading,
}: FeaturedCarouselProps) {
  const router = useRouter();
  const { formatPrice } = useCurrency();
  const [currentIndex, setCurrentIndex] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startAutoScroll = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (programs.length <= 1) return;
    intervalRef.current = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % programs.length);
    }, 5000);
  }, [programs.length]);

  useEffect(() => {
    startAutoScroll();
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [startAutoScroll]);

  const goTo = (index: number) => {
    setCurrentIndex(index);
    startAutoScroll();
  };

  const prev = () =>
    goTo((currentIndex - 1 + programs.length) % programs.length);
  const next = () => goTo((currentIndex + 1) % programs.length);

  if (isLoading) return <SkeletonSlide />;
  if (programs.length === 0) return null;

  const program = programs[currentIndex];

  // Extract instructor work experiences for company logos
  const workExperiences = program.consultantProfile?.user?.workExperiences ?? [];

  const handleClick = () => {
    if (isClassProgram(program)) {
      router.push(`/explore/programs/plans/classes/${program.id}`);
    } else {
      router.push(`/explore/programs/plans/webinars/${program.id}`);
    }
  };

  return (
    <div className="relative">
      <div
        className="group bg-card rounded-2xl overflow-hidden border border-border hover:border-border hover:shadow-xl transition-all duration-300 cursor-pointer"
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClick();
          }
        }}
        aria-label={`View details for ${program.title}`}
      >
        <div className="flex flex-col md:flex-row h-auto md:h-[280px]">
          {/* Image */}
          <div className="relative md:w-[400px] flex-shrink-0 h-[200px] md:h-full overflow-hidden">
            <Image
              src={program.imageUrl}
              alt={program.title}
              fill
              className="object-cover group-hover:scale-105 transition-transform duration-500"
              sizes="(max-width: 768px) 100vw, 400px"
              priority
            />
            <div className="absolute top-4 left-4 flex gap-2">
              <span
                className={`px-3 py-1 rounded-full text-xs font-medium ${
                  program.type === "class"
                    ? "bg-primary text-primary-foreground"
                    : "bg-card text-foreground"
                }`}
              >
                {program.type === "class" ? "Class" : "Webinar"}
              </span>
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-500 text-white">
                <Sparkles className="w-3 h-3" />
                Featured
              </span>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 p-6 md:p-8 flex flex-col justify-center min-w-0">
            <h3 className="text-xl md:text-2xl font-bold text-foreground mb-3 line-clamp-2 group-hover:text-muted-foreground transition-colors">
              {program.title}
            </h3>
            <p className="text-sm md:text-base text-muted-foreground mb-6 line-clamp-3">
              {program.description}
            </p>
            <div className="flex items-center gap-4">
              <span className="text-2xl font-bold text-foreground">
                {formatPrice(program.price)}
              </span>
              {workExperiences.length > 0 && (
                <div className="flex items-center gap-1.5">
                  {workExperiences.slice(0, 3).map((exp, i) => (
                    <CompanyLogo
                      key={`featured-company-${program.id}-${i}`}
                      companyName={exp.company}
                      companyDomain={exp.companyDomain ?? undefined}
                      size={24}
                      className="border-border"
                    />
                  ))}
                </div>
              )}
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground group-hover:text-foreground transition-colors">
                View Details
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Navigation */}
      {programs.length > 1 && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation();
              prev();
            }}
            className="absolute left-3 top-1/2 -translate-y-1/2 z-10 w-9 h-9 rounded-full bg-card/90 backdrop-blur border border-border shadow-md flex items-center justify-center hover:bg-card transition-colors"
            aria-label="Previous"
          >
            <ChevronLeft className="w-4 h-4 text-muted-foreground" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              next();
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 z-10 w-9 h-9 rounded-full bg-card/90 backdrop-blur border border-border shadow-md flex items-center justify-center hover:bg-card transition-colors"
            aria-label="Next"
          >
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </button>

          {/* Dots */}
          <div className="flex justify-center gap-2 mt-4">
            {programs.map((_, i) => (
              <button
                key={i}
                onClick={(e) => {
                  e.stopPropagation();
                  goTo(i);
                }}
                className={`w-2 h-2 rounded-full transition-all duration-200 ${
                  i === currentIndex
                    ? "bg-primary w-6"
                    : "bg-muted-foreground/30 hover:bg-muted-foreground/50"
                }`}
                aria-label={`Go to slide ${i + 1}`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const FeaturedCarousel = memo(FeaturedCarouselImpl);
export default FeaturedCarousel;
