"use client";

import { memo } from "react";
import { RegistrationBadge } from "@/components/ui/registration-badge";
import { Button } from "@/components/ui/button";
import { ArrowRight, Flame, Sparkles, Star } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCurrency } from "@/hooks/useCurrency";
import { CompanyLogo } from "@/components/ui/company-logo";
import { isClassProgram, Program } from "@/lib/explore/programs";

type ProgramCardVariant = "grid" | "list" | "carousel";
export type ProgramBadge = "featured" | "trending" | "new";

interface ProgramCardProps {
  program: Program;
  variant?: ProgramCardVariant;
  badge?: ProgramBadge;
  /** #664 — viewer's ACTIVE org memberships as { orgId: orgName }. */
  viewerOrgs?: Record<string, string>;
}

// Curation state is a neutral taxonomy, not a status — colour is reserved for
// destructive/success/warning/info here, so these read monochrome (filled for
// the editorial pick, muted for the derived ones) and survive dark mode.
const badgeConfig: Record<
  ProgramBadge,
  { label: string; icon: React.ReactNode; className: string }
> = {
  featured: {
    label: "Familiarise Pick",
    icon: <Sparkles className="w-3 h-3" />,
    className: "bg-primary text-primary-foreground",
  },
  trending: {
    label: "Trending",
    icon: <Flame className="w-3 h-3" />,
    className: "bg-background/90 text-foreground border border-border",
  },
  new: {
    label: "New",
    icon: <Sparkles className="w-3 h-3" />,
    className: "bg-background/90 text-foreground border border-border",
  },
};

function TypeBadge({ type }: { type: "class" | "webinar" }) {
  return (
    <span
      className={`px-3 py-1 rounded-full text-xs font-medium ${
        type === "class"
          ? "bg-primary text-primary-foreground"
          : "bg-card text-foreground"
      }`}
    >
      {type === "class" ? "Class" : "Webinar"}
    </span>
  );
}

function ExtraBadge({ badge }: { badge: ProgramBadge }) {
  const config = badgeConfig[badge];
  return (
    <span
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${config.className}`}
    >
      {config.icon}
      {config.label}
    </span>
  );
}

/** Extract consultant rating from plan data if available (API includes consultantProfile). */
function getProgramRating(program: Program): number | null {
  return program.consultantProfile?.rating ?? null;
}

/** Extract consultant headline from plan data if available. */
function getProgramInstructor(
  program: Program,
): { headline: string } | null {
  const headline = program.consultantProfile?.headline;
  if (headline) return { headline };
  return null;
}

/** Extract instructor work experiences (for company logo stickers), including collaborator experiences (deduplicated). */
function getInstructorWorkExperiences(
  program: Program,
): Array<{ company: string; companyDomain: string | null; isCurrent: boolean }> {
  const primaryExps = program.consultantProfile?.user?.workExperiences ?? [];

  // Merge collaborator work experiences
  const collaborators = program.collaborators;
  if (!collaborators?.length) return primaryExps;

  const seen = new Set(primaryExps.map((e) => e.company.toLowerCase()));
  const merged = [...primaryExps];
  for (const collab of collaborators) {
    for (const exp of collab.consultantProfile?.user?.workExperiences ?? []) {
      const key = exp.company.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(exp);
      }
    }
  }
  return merged;
}

function GridCard({
  program,
  badge,
}: {
  program: Program;
  badge?: ProgramBadge;
}) {
  const router = useRouter();
  const { formatPrice } = useCurrency();
  const rating = getProgramRating(program);
  const instructor = getProgramInstructor(program);
  const workExperiences = getInstructorWorkExperiences(program);

  const handleClick = () => {
    if (isClassProgram(program)) {
      router.push(`/explore/programs/plans/classes/${program.id}`);
    } else {
      router.push(`/explore/programs/plans/webinars/${program.id}`);
    }
  };

  return (
    <div
      className="group bg-card rounded-2xl overflow-hidden border border-border hover:border-border hover:shadow-xl transition-all duration-300 cursor-pointer h-full flex flex-col"
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`View details for ${program.title}`}
    >
      <div className="relative aspect-[16/10] overflow-hidden">
        <Image
          src={program.imageUrl}
          alt={program.title}
          fill
          className="object-cover group-hover:scale-105 transition-transform duration-500"
          sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
        />
        <div className="absolute top-3 left-3 flex gap-2">
          <TypeBadge type={program.type} />
          {program.isRegistered && (
            <RegistrationBadge
              type={isClassProgram(program) ? "class" : "webinar"}
              compact
            />
          )}
        </div>
        {badge && (
          <div className="absolute top-3 right-3">
            <ExtraBadge badge={badge} />
          </div>
        )}
      </div>

      <div className="p-5 flex-1 flex flex-col">
        <h3 className="text-lg font-semibold text-foreground mb-2 line-clamp-1 group-hover:text-muted-foreground transition-colors">
          {program.title}
        </h3>
        <p className="text-sm text-muted-foreground mb-4 line-clamp-2 flex-1">
          {program.description}
        </p>

        {/* Instructor info + company logos */}
        {(instructor || workExperiences.length > 0) && (
          <div className="flex items-center gap-2 mb-3">
            {workExperiences.slice(0, 2).map((exp, i) => (
              <CompanyLogo
                key={`grid-company-${program.id}-${i}`}
                companyName={exp.company}
                companyDomain={exp.companyDomain ?? undefined}
                size={20}
                className="border-border"
              />
            ))}
            {instructor && (
              <span className="text-xs text-muted-foreground/70 line-clamp-1">
                {instructor.headline}
              </span>
            )}
          </div>
        )}

        <div className="flex items-center justify-between pt-4 border-t border-border">
          <div className="flex items-center gap-2">
            <div className="text-xl font-bold text-foreground">
              {formatPrice(program.price)}
            </div>
            {rating !== null && rating > 0 && (
              <div className="flex items-center gap-0.5 ml-1">
                <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                <span className="text-xs font-medium text-muted-foreground">
                  {rating.toFixed(1)}
                </span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 text-sm font-medium text-muted-foreground group-hover:text-foreground transition-colors">
            <span>View Details</span>
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </div>
        </div>

        <div className="flex items-center gap-1 mt-2">
          <Image
            src="/avif/static/assets/logos/images/logos/Familiarise-logos_transparent.avif"
            alt="Familiarise"
            width={12}
            height={12}
          />
          <span className="text-[10px] text-muted-foreground/70">on Familiarise</span>
        </div>
      </div>
    </div>
  );
}

function ListCard({
  program,
  badge,
}: {
  program: Program;
  badge?: ProgramBadge;
}) {
  const router = useRouter();
  const { formatPrice } = useCurrency();
  const rating = getProgramRating(program);
  const instructor = getProgramInstructor(program);
  const workExperiences = getInstructorWorkExperiences(program);

  const handleClick = () => {
    if (isClassProgram(program)) {
      router.push(`/explore/programs/plans/classes/${program.id}`);
    } else {
      router.push(`/explore/programs/plans/webinars/${program.id}`);
    }
  };

  return (
    <div
      className="group bg-card rounded-2xl overflow-hidden border border-border hover:border-border hover:shadow-xl transition-all duration-300 cursor-pointer flex"
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`View details for ${program.title}`}
    >
      <div className="relative w-48 md:w-64 flex-shrink-0">
        <Image
          src={program.imageUrl}
          alt={program.title}
          fill
          className="object-cover"
          sizes="256px"
        />
        <div className="absolute top-3 left-3 flex gap-2">
          <TypeBadge type={program.type} />
          {badge && <ExtraBadge badge={badge} />}
        </div>
      </div>

      <div className="p-6 flex-1 flex flex-col justify-between min-w-0">
        <div>
          <div className="flex items-start justify-between gap-4 mb-2">
            <h3 className="text-lg font-semibold text-foreground group-hover:text-muted-foreground transition-colors">
              {program.title}
            </h3>
            {program.isRegistered && (
              <RegistrationBadge
                type={isClassProgram(program) ? "class" : "webinar"}
                compact
              />
            )}
          </div>
          <p className="text-sm text-muted-foreground line-clamp-2">
            {program.description}
          </p>
          {/* Instructor info + company logos */}
          {(instructor || workExperiences.length > 0) && (
            <div className="flex items-center gap-2 mt-2">
              {workExperiences.slice(0, 3).map((exp, i) => (
                <CompanyLogo
                  key={`list-company-${program.id}-${i}`}
                  companyName={exp.company}
                  companyDomain={exp.companyDomain ?? undefined}
                  size={22}
                  className="border-border"
                />
              ))}
              {instructor && (
                <span className="text-xs text-muted-foreground/70 line-clamp-1">
                  {instructor.headline}
                </span>
              )}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mt-4">
            <div className="flex items-center gap-2">
              <div className="text-xl font-bold text-foreground">
                {formatPrice(program.price)}
              </div>
              {rating !== null && rating > 0 && (
                <div className="flex items-center gap-0.5 ml-1">
                  <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                  <span className="text-xs font-medium text-muted-foreground">
                    {rating.toFixed(1)}
                  </span>
                </div>
              )}
            </div>
            <Button
              variant="outline"
              className="rounded-xl border-border hover:bg-muted"
              onClick={(e) => {
                e.stopPropagation();
                handleClick();
              }}
            >
              View Details
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
          <div className="flex items-center gap-1 mt-2">
            <Image
              src="/avif/static/assets/logos/images/logos/Familiarise-logos_transparent.avif"
              alt="Familiarise"
              width={12}
              height={12}
            />
            <span className="text-[10px] text-muted-foreground/70">on Familiarise</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function CarouselCard({
  program,
  badge,
}: {
  program: Program;
  badge?: ProgramBadge;
}) {
  const router = useRouter();
  const { formatPrice } = useCurrency();
  const workExperiences = getInstructorWorkExperiences(program);

  const handleClick = () => {
    if (isClassProgram(program)) {
      router.push(`/explore/programs/plans/classes/${program.id}`);
    } else {
      router.push(`/explore/programs/plans/webinars/${program.id}`);
    }
  };

  return (
    <div
      className="group bg-card rounded-2xl overflow-hidden border border-border hover:border-border hover:shadow-xl transition-all duration-300 cursor-pointer flex-shrink-0 w-[320px] md:w-[360px]"
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`View details for ${program.title}`}
    >
      <div className="relative aspect-[16/10] overflow-hidden">
        <Image
          src={program.imageUrl}
          alt={program.title}
          fill
          className="object-cover group-hover:scale-105 transition-transform duration-500"
          sizes="360px"
        />
        <div className="absolute top-3 left-3 flex gap-2">
          <TypeBadge type={program.type} />
        </div>
        {badge && (
          <div className="absolute top-3 right-3">
            <ExtraBadge badge={badge} />
          </div>
        )}
      </div>

      <div className="p-4">
        <h3 className="text-base font-semibold text-foreground mb-1 line-clamp-1 group-hover:text-muted-foreground transition-colors">
          {program.title}
        </h3>
        <p className="text-sm text-muted-foreground line-clamp-1 mb-3">
          {program.description}
        </p>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="text-lg font-bold text-foreground">
              {formatPrice(program.price)}
            </div>
            {workExperiences.length > 0 && (
              <div className="flex items-center gap-1">
                {workExperiences.slice(0, 2).map((exp, i) => (
                  <CompanyLogo
                    key={`carousel-company-${program.id}-${i}`}
                    companyName={exp.company}
                    companyDomain={exp.companyDomain ?? undefined}
                    size={18}
                    className="border-border"
                  />
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 text-sm font-medium text-muted-foreground group-hover:text-foreground transition-colors">
            <span>View</span>
            <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ProgramCardImpl({
  program,
  variant = "grid",
  badge,
  viewerOrgs,
}: ProgramCardProps) {
  const card = (() => {
    switch (variant) {
      case "list":
        return <ListCard program={program} badge={badge} />;
      case "carousel":
        return <CarouselCard program={program} badge={badge} />;
      default:
        return <GridCard program={program} badge={badge} />;
    }
  })();

  // #664 — badge a plan the viewer's org sponsors. Rendered as a chip above the
  // card (no collision with the type/registration/extra badges on the image).
  const orgName = program.organizationId
    ? viewerOrgs?.[program.organizationId]
    : undefined;
  if (!orgName) return card;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="inline-flex w-fit items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
        Recommended by {orgName}
      </span>
      {card}
    </div>
  );
}

const ProgramCard = memo(ProgramCardImpl);
export default ProgramCard;
