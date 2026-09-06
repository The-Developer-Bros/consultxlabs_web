"use client";

import { memo } from "react";
import { RegistrationBadge } from "@/components/ui/registration-badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Flame, Sparkles, Star, User } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCurrency } from "@/hooks/useCurrency";
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

const OVERLAY_CHIP =
  "inline-flex items-center gap-1 rounded-full border border-border bg-background/90 px-2.5 py-1 text-xs font-medium text-foreground backdrop-blur";

// Curation state is a neutral taxonomy, not a status — colour is reserved for
// destructive/success/warning/info here, so these read monochrome (filled for
// the editorial pick, outlined for the derived ones) and survive dark mode.
const badgeConfig: Record<
  ProgramBadge,
  { label: string; icon: React.ReactNode; className: string }
> = {
  featured: {
    label: "Familiarise Pick",
    icon: <Sparkles className="h-3 w-3" />,
    className:
      "inline-flex items-center gap-1 rounded-full border border-transparent bg-foreground px-2.5 py-1 text-xs font-medium text-background",
  },
  trending: {
    label: "Trending",
    icon: <Flame className="h-3 w-3" />,
    className: OVERLAY_CHIP,
  },
  new: {
    label: "New",
    icon: <Sparkles className="h-3 w-3" />,
    className: OVERLAY_CHIP,
  },
};

const SHELL_BASE =
  "group cursor-pointer overflow-hidden rounded-2xl border border-border bg-card shadow-elevation-1 transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-elevation-2";

/** Grid and carousel stack vertically; the list variant is a two-column grid. */
const SHELL = `${SHELL_BASE} flex h-full flex-col`;

function TypeBadge({ type }: { type: "class" | "webinar" }) {
  return (
    <span className={OVERLAY_CHIP}>
      {type === "class" ? "Class" : "Webinar"}
    </span>
  );
}

function ExtraBadge({ badge }: { badge: ProgramBadge }) {
  const config = badgeConfig[badge];
  return (
    <span className={config.className}>
      {config.icon}
      {config.label}
    </span>
  );
}

/** Extract consultant rating from plan data if available (API includes consultantProfile). */
function getProgramRating(program: Program): number | null {
  return program.consultantProfile?.rating ?? null;
}

function InstructorRow({ program }: { program: Program }) {
  const user = program.consultantProfile?.user;
  const headline = program.consultantProfile?.headline;
  if (!user || (!user.name && !headline)) return null;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Avatar className="h-5 w-5 shrink-0">
        <AvatarImage
          src={user.image || undefined}
          alt={user.name || "Instructor"}
        />
        <AvatarFallback className="bg-muted text-muted-foreground">
          <User className="h-3 w-3" />
        </AvatarFallback>
      </Avatar>
      <p className="line-clamp-1 min-w-0 text-xs text-muted-foreground">
        {user.name}
        {headline && (
          <span className="text-muted-foreground/70">
            {user.name ? " · " : ""}
            {headline}
          </span>
        )}
      </p>
    </div>
  );
}

function CardFooter({
  program,
  trailing,
}: {
  program: Program;
  /** Replaces the default "Details →" affordance (the list variant's button). */
  trailing?: React.ReactNode;
}) {
  const { formatPrice } = useCurrency();
  const rating = getProgramRating(program);

  return (
    <div className="mt-auto flex items-center justify-between gap-3 border-t border-border pt-3">
      <div className="flex items-center gap-2">
        <span className="font-semibold tabular-nums text-foreground">
          {formatPrice(program.price)}
        </span>
        {rating !== null && rating > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
            <span className="text-xs font-medium tabular-nums text-muted-foreground">
              {rating.toFixed(1)}
            </span>
          </span>
        )}
      </div>
      {trailing ?? (
        <span className="text-sm font-medium text-muted-foreground transition-colors group-hover:text-foreground">
          Details →
        </span>
      )}
    </div>
  );
}

/** The shared "open this plan's detail page" navigation. */
function usePlanNavigation(program: Program) {
  const router = useRouter();
  return () => {
    if (isClassProgram(program)) {
      router.push(`/explore/programs/plans/classes/${program.id}`);
    } else {
      router.push(`/explore/programs/plans/webinars/${program.id}`);
    }
  };
}

function GridCard({
  program,
  badge,
}: {
  program: Program;
  badge?: ProgramBadge;
}) {
  const handleClick = usePlanNavigation(program);

  return (
    <div
      className={SHELL}
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
          className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
        />
        <div className="absolute left-3 top-3 flex gap-2">
          <TypeBadge type={program.type} />
          {program.isRegistered && (
            <RegistrationBadge
              type={isClassProgram(program) ? "class" : "webinar"}
              compact
            />
          )}
        </div>
        {badge && (
          <div className="absolute right-3 top-3">
            <ExtraBadge badge={badge} />
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <h3 className="line-clamp-2 text-base font-semibold tracking-tight text-foreground">
          {program.title}
        </h3>
        <InstructorRow program={program} />
        <p className="line-clamp-2 text-sm text-muted-foreground">
          {program.description}
        </p>
        <CardFooter program={program} />
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
  const handleClick = usePlanNavigation(program);

  return (
    <div
      className={`${SHELL_BASE} grid grid-cols-[180px_1fr] md:grid-cols-[260px_1fr]`}
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
      <div className="relative h-full min-h-[160px] overflow-hidden">
        <Image
          src={program.imageUrl}
          alt={program.title}
          fill
          className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          sizes="260px"
        />
        <div className="absolute left-3 top-3 flex flex-wrap gap-2">
          <TypeBadge type={program.type} />
          {badge && <ExtraBadge badge={badge} />}
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="line-clamp-2 text-base font-semibold tracking-tight text-foreground">
            {program.title}
          </h3>
          {program.isRegistered && (
            <RegistrationBadge
              type={isClassProgram(program) ? "class" : "webinar"}
              compact
            />
          )}
        </div>
        <InstructorRow program={program} />
        <p className="line-clamp-2 text-sm text-muted-foreground">
          {program.description}
        </p>

        <CardFooter
          program={program}
          trailing={
            <Button
              variant="outline"
              className="h-10 shrink-0 rounded-xl border-border"
              onClick={(e) => {
                e.stopPropagation();
                handleClick();
              }}
            >
              View details
            </Button>
          }
        />
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
  const handleClick = usePlanNavigation(program);

  return (
    <div
      className={`${SHELL} w-[320px] shrink-0 md:w-[360px]`}
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
          className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          sizes="360px"
        />
        <div className="absolute left-3 top-3 flex gap-2">
          <TypeBadge type={program.type} />
        </div>
        {badge && (
          <div className="absolute right-3 top-3">
            <ExtraBadge badge={badge} />
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <h3 className="line-clamp-2 text-base font-semibold tracking-tight text-foreground">
          {program.title}
        </h3>
        <InstructorRow program={program} />
        <CardFooter program={program} />
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
      <span className="inline-flex w-fit items-center rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground">
        Recommended by {orgName}
      </span>
      {card}
    </div>
  );
}

const ProgramCard = memo(ProgramCardImpl);
export default ProgramCard;
