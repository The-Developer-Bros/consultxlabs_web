"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Sparkles, User } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { CompanyLogo } from "@/components/ui/company-logo";
import { useCurrency } from "@/hooks/useCurrency";
import { isClassProgram, Program } from "@/lib/explore/programs";

interface FeaturedCarouselProps {
  programs: Program[];
  isLoading?: boolean;
}

const OVERLAY_CHIP =
  "inline-flex items-center gap-1 rounded-full border border-border bg-background/90 px-2.5 py-1 text-xs font-medium text-foreground backdrop-blur";

const NAV_BUTTON =
  "absolute top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card shadow-elevation-2 transition-colors hover:bg-muted";

function SkeletonSlide() {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card md:grid md:grid-cols-[400px_1fr]">
      <div className="h-[220px] animate-pulse bg-muted md:h-full" />
      <div className="space-y-4 p-6 md:p-8">
        <div className="h-3 w-32 animate-pulse rounded bg-muted" />
        <div className="h-7 w-3/4 animate-pulse rounded bg-muted" />
        <div className="h-4 w-full animate-pulse rounded bg-muted" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-6 w-40 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

function FeaturedCarouselImpl({ programs, isLoading }: FeaturedCarouselProps) {
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
  const instructor = program.consultantProfile?.user;
  const workExperiences = instructor?.workExperiences ?? [];

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
        className="group cursor-pointer overflow-hidden rounded-2xl border border-border bg-card shadow-elevation-1 transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-elevation-2 md:grid md:grid-cols-[400px_1fr]"
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
        <div className="relative h-[220px] overflow-hidden md:h-full">
          <Image
            src={program.imageUrl}
            alt={program.title}
            fill
            className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
            sizes="(max-width: 768px) 100vw, 400px"
            priority
          />
          <div className="absolute left-4 top-4 flex flex-wrap gap-2">
            <span className={OVERLAY_CHIP}>
              {program.type === "class" ? "Class" : "Webinar"}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-transparent bg-foreground px-2.5 py-1 text-xs font-medium text-background">
              <Sparkles className="h-3 w-3" />
              Featured
            </span>
          </div>
        </div>

        <div className="flex min-w-0 flex-col justify-center p-6 md:p-8">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Familiarise featured
          </p>
          <h3 className="mt-3 line-clamp-2 text-2xl font-semibold tracking-tight text-foreground">
            {program.title}
          </h3>
          <p className="mt-3 line-clamp-3 text-sm text-muted-foreground md:text-base">
            {program.description}
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
            <span className="text-xl font-semibold tabular-nums text-foreground">
              {formatPrice(program.price)}
            </span>

            {instructor?.name && (
              <span className="inline-flex min-w-0 items-center gap-2">
                <Avatar className="h-7 w-7 shrink-0">
                  <AvatarImage
                    src={instructor.image || undefined}
                    alt={instructor.name}
                  />
                  <AvatarFallback className="bg-muted text-muted-foreground">
                    <User className="h-3.5 w-3.5" />
                  </AvatarFallback>
                </Avatar>
                <span className="truncate text-sm text-muted-foreground">
                  {instructor.name}
                </span>
              </span>
            )}

            {workExperiences.length > 0 && (
              <span className="flex items-center gap-1.5">
                {workExperiences.slice(0, 3).map((exp, i) => (
                  <CompanyLogo
                    key={`featured-company-${program.id}-${i}`}
                    companyName={exp.company}
                    companyDomain={exp.companyDomain ?? undefined}
                    size={22}
                    className="border-border"
                  />
                ))}
              </span>
            )}

            <span className="text-sm font-medium text-muted-foreground transition-colors group-hover:text-foreground">
              View details →
            </span>
          </div>
        </div>
      </div>

      {programs.length > 1 && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              prev();
            }}
            className={`left-3 ${NAV_BUTTON}`}
            aria-label="Previous"
          >
            <ChevronLeft className="h-4 w-4 text-muted-foreground" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              next();
            }}
            className={`right-3 ${NAV_BUTTON}`}
            aria-label="Next"
          >
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>

          <div className="mt-4 flex justify-center gap-2">
            {programs.map((slide, i) => (
              <button
                key={slide.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  goTo(i);
                }}
                className={`h-1.5 rounded-full transition-all duration-200 ${
                  i === currentIndex
                    ? "w-5 bg-foreground"
                    : "w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/50"
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
