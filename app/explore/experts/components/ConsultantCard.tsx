"use client";

import { memo } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Image from "next/image";
import Link from "next/link";
import type { IConsultantCardData } from "@/types/consultant";
import { CompanyLogo } from "@/components/ui/company-logo";
import { Star, Globe, BadgeCheck, Building2 } from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";
import { cn } from "@/utils/tailwind";

interface ConsultantCardProps {
  consultant: IConsultantCardData;
  metadata: {
    domains: { id: string; name: string }[];
    subdomains: { id: string; name: string }[];
    tags: { id: string; name: string }[];
  } | null;
}

/**
 * Returns true if `value` is a non-empty string that isn't one of the
 * placeholder sentinels users/seeds sometimes leave behind ("none", "n/a", …).
 */
const isMeaningfulText = (
  value: string | null | undefined,
): value is string => {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return !/^(none|n\/?a|na|null|nil|tbd|-+|\.+)$/i.test(trimmed);
};

const formatDuration = (months: number) => {
  switch (months) {
    case 1:
      return "1 month";
    case 3:
      return "3 months";
    case 6:
      return "6 months";
    case 12:
      return "1 year";
    default:
      return `${months} months`;
  }
};

/** Taxonomy chip. `primary` marks the one that names the expert's domain. */
function Chip({
  children,
  primary = false,
}: {
  children: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium",
        primary
          ? "border-transparent bg-foreground text-background"
          : "border-border bg-background text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

export const ConsultantCard = memo(function ConsultantCard({
  consultant,
  metadata: _metadata,
}: ConsultantCardProps) {
  const { formatPrice } = useCurrency();
  const profileHref = `/explore/experts/${consultant.id}`;

  const sortedPlans =
    consultant.subscriptionPlans
      ?.slice()
      .sort((a, b) => a.durationInMonths - b.durationInMonths) || [];

  // Trial CTA is driven by real plan data. Previously it rendered
  // unconditionally, so an expert offering no trial — or one whose trial is
  // priced — showed a button that dead-ended. Cheapest trial across the
  // consultant's plans is the honest headline price.
  const trialPlans = sortedPlans.filter((plan) => plan.trialEnabled);
  const trialOffer =
    trialPlans.length > 0
      ? {
          priceInPaise: Math.min(
            ...trialPlans.map((plan) => plan.trialPriceInPaise ?? 0),
          ),
        }
      : null;

  return (
    <div className="grid gap-6 rounded-2xl border border-border bg-card p-5 shadow-elevation-1 transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-elevation-2 md:p-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      {/* Uses a stretched overlay <Link> (absolute inset-0) instead of wrapping
          the column, so the nested org-badge link stays valid HTML (no <a>
          inside <a>) while right-click / cmd-click / middle-click still open
          the profile. */}
      <div className="relative min-w-0">
        <Link
          href={profileHref}
          aria-label={`View ${consultant.user.name}'s profile`}
          className="absolute inset-0 z-0"
        />

        <div className="flex items-start gap-4">
          <div className="relative h-16 w-16 shrink-0">
            <Image
              alt={`Portrait of ${consultant.user.name}`}
              className="rounded-xl object-cover ring-1 ring-border"
              src={consultant.user.image || "/placeholder-user.jpg"}
              fill
              // 64×64 slot — without sizes, `fill` fetches a 100vw image (#932 perf).
              sizes="64px"
            />
          </div>

          <div className="min-w-0 flex-1">
            {/* Name and org badge share one row, so neither may wrap: a long
                org name ("Indian Institute of Technology Madras") otherwise
                breaks onto a second line and squeezes the name into wrapping
                too. Both truncate instead, and the badge keeps its `title`
                so the full name is still reachable on hover. */}
            <div className="flex min-w-0 items-center gap-1.5">
              <h3 className="truncate text-lg font-semibold text-foreground">
                {consultant.user.name}
              </h3>
              {consultant.isVerified && (
                <span title="Verified by Familiarise" className="shrink-0">
                  <BadgeCheck className="h-4 w-4 text-foreground" />
                </span>
              )}
              {consultant.organizationBadge && (
                <Link
                  href={`/explore/enterprise/organisations/${consultant.organizationBadge.slug}`}
                  title={consultant.organizationBadge.name}
                  onClick={(e) => e.stopPropagation()}
                  className="relative z-10 min-w-0"
                >
                  <Badge
                    variant="outline"
                    className="max-w-[180px] whitespace-nowrap border-border px-1.5 py-0 text-[10px] text-muted-foreground transition-colors hover:bg-muted"
                  >
                    <Building2 className="mr-0.5 h-3 w-3 shrink-0" />
                    <span className="truncate">
                      {consultant.organizationBadge.name}
                    </span>
                  </Badge>
                </Link>
              )}
            </div>

            {isMeaningfulText(consultant.headline) && (
              <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">
                {consultant.headline.trim()}
              </p>
            )}

            {/* #705 — a null score means too few rated sessions to publish
                one. Say that rather than printing 0.0, which reads as a bad
                consultant instead of a new one. */}
            <div className="mt-1.5 flex items-center gap-2 text-sm">
              {consultant.rating !== null && (
                <>
                  <span className="inline-flex items-center gap-1">
                    <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                    <span className="font-semibold tabular-nums text-foreground">
                      {consultant.rating.toFixed(1)}
                    </span>
                  </span>
                  <span className="text-muted-foreground/70" aria-hidden>
                    ·
                  </span>
                </>
              )}
              <span className="tabular-nums text-muted-foreground">
                {(() => {
                  const n =
                    consultant.reviewCount ?? consultant.reviews?.length ?? 0;
                  return `${n} review${n === 1 ? "" : "s"}`;
                })()}
              </span>
            </div>
          </div>
        </div>

        {/* Description — only render when it's meaningful free-form text */}
        {isMeaningfulText(consultant.description) && (
          <p className="mt-4 line-clamp-2 text-sm text-muted-foreground">
            {consultant.description.trim()}
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {consultant.domain?.name && (
            <Chip primary>{consultant.domain.name}</Chip>
          )}
          {consultant.subDomains.slice(0, 2).map((sd) => (
            <Chip key={`${consultant.id}-subdomain-${sd.id}`}>{sd.name}</Chip>
          ))}
          {consultant.experience ? (
            <Chip>
              <span className="tabular-nums">{consultant.experience}</span> yrs
            </Chip>
          ) : null}
          {consultant.languages && consultant.languages.length > 0 && (
            <Chip>
              <Globe className="h-3 w-3" />
              {consultant.languages.join(", ")}
            </Chip>
          )}
          {consultant.tags.slice(0, 3).map((t) => (
            <Chip key={`${consultant.id}-tag-${t.id}`}>{t.name}</Chip>
          ))}
        </div>

        {consultant.user.workExperiences &&
          consultant.user.workExperiences.length > 0 && (
            <div className="mt-4 flex items-center gap-2">
              {consultant.user.workExperiences.slice(0, 3).map((exp, i) => (
                <CompanyLogo
                  key={`${consultant.id}-company-${i}`}
                  companyName={exp.company}
                  companyDomain={exp.companyDomain ?? undefined}
                  size={28}
                  className="border-border"
                />
              ))}
              <span className="ml-1 truncate text-sm text-muted-foreground">
                {consultant.user.workExperiences[0].company}
                {consultant.user.workExperiences.length > 1 &&
                  ` +${consultant.user.workExperiences.length - 1}`}
              </span>
            </div>
          )}
      </div>

      <div className="flex flex-col gap-4 lg:border-l lg:border-border lg:pl-6">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Mentorship plans
        </p>

        {sortedPlans.length > 0 ? (
          <div>
            {sortedPlans.slice(0, 3).map((plan) => (
              <div
                key={`${consultant.id}-plan-${plan.id}`}
                className="flex items-baseline justify-between gap-3 border-b border-border py-2 last:border-0"
              >
                <span className="text-sm font-medium text-foreground">
                  {formatDuration(plan.durationInMonths)}
                  {plan.sessionsPerWeek !== null &&
                    plan.sessionsPerWeek !== undefined &&
                    plan.sessionsPerWeek > 0 && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {plan.sessionsPerWeek}/wk
                      </span>
                    )}
                </span>
                <span className="font-semibold tabular-nums text-foreground">
                  {formatPrice(plan.price)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No mentorship plans yet
          </p>
        )}

        {/* Wrapped in <Link> via Button asChild so the browser context menu
            offers "Open in new tab" / "Copy link". */}
        <div className="mt-auto space-y-2">
          <Button asChild className="h-11 w-full rounded-xl">
            <Link href={profileHref}>View profile</Link>
          </Button>
          <div className="grid grid-cols-2 gap-2">
            {trialOffer && (
              <Button
                asChild
                variant="outline"
                className="h-10 rounded-xl border-border text-sm font-medium"
              >
                <Link href={`${profileHref}?action=trial`}>
                  {trialOffer.priceInPaise > 0
                    ? `Trial · ${formatPrice(trialOffer.priceInPaise)}`
                    : "Free intro call"}
                </Link>
              </Button>
            )}
            <Button
              asChild
              variant="outline"
              className={cn(
                "h-10 rounded-xl border-border text-sm font-medium",
                !trialOffer && "col-span-2",
              )}
            >
              <Link href={`${profileHref}?action=book`}>Book session</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});
