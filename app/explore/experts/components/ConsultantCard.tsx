"use client";

import { memo } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import Image from "next/image";
import Link from "next/link";
import type { IConsultantCardData } from "@/types/consultant";
import { CompanyLogo } from "@/components/ui/company-logo";
import {
  Star,
  Clock,
  Briefcase,
  Globe,
  ArrowRight,
  CheckCircle2,
  BadgeCheck,
  Building2,
} from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";

interface ConsultantCardProps {
  consultant: IConsultantCardData;
  metadata: {
    domains: { id: string; name: string }[];
    subdomains: { id: string; name: string }[];
    tags: { id: string; name: string }[];
  } | null;
}

const ConsultantInfo = ({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: string | null | undefined;
}) => (
  <div className="flex items-center gap-2 text-sm">
    <Icon className="w-4 h-4 text-muted-foreground/70" />
    <span className="text-muted-foreground">{label}:</span>
    <span className="text-foreground font-medium">
      {value || "Not specified"}
    </span>
  </div>
);

/**
 * A labelled row of badges. The label column is fixed-width so the "Domain" and
 * "Skills" rows align with each other and with the ConsultantInfo rows above.
 */
const BadgeRow = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <div className="flex items-start gap-2 mt-2">
    <span className="w-16 shrink-0 pt-1.5 text-sm text-muted-foreground">
      {label}:
    </span>
    <div className="flex flex-wrap gap-2">{children}</div>
  </div>
);

interface SubscriptionPlanCardData {
  price: number;
  durationInMonths: number;
  sessionsPerWeek: number | null;
  emailSupport: string | null;
  totalSessions: number | null;
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

const SubscriptionPlanCard = ({
  plan,
  formatPrice,
}: {
  plan: SubscriptionPlanCardData;
  formatPrice: (amountINR: number) => string;
}) => {
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

  return (
    <div className="bg-card rounded-xl p-5 border border-border">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
        <div className="text-2xl sm:text-3xl font-bold text-foreground">
          {formatPrice(plan.price)}
        </div>
        <div className="text-xs sm:text-sm text-muted-foreground font-medium bg-muted px-2 sm:px-3 py-1 rounded-full whitespace-nowrap">
          {formatDuration(plan.durationInMonths)}
        </div>
      </div>
      <div className="space-y-2.5">
        {plan.sessionsPerWeek !== null &&
          plan.sessionsPerWeek !== undefined &&
          plan.sessionsPerWeek > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              <span className="text-muted-foreground">
                {plan.sessionsPerWeek}{" "}
                {plan.sessionsPerWeek === 1 ? "session" : "sessions"}
                /week
              </span>
            </div>
          )}
        {plan.emailSupport && (
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span className="text-muted-foreground capitalize">
              {plan.emailSupport.toLowerCase()} email support
            </span>
          </div>
        )}
        {plan.totalSessions !== null &&
          plan.totalSessions !== undefined &&
          plan.totalSessions > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              <span className="text-muted-foreground">
                {plan.totalSessions}{" "}
                {plan.totalSessions === 1 ? "session" : "sessions"} total
              </span>
            </div>
          )}
      </div>
    </div>
  );
};

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

  // Count how many plans share each duration so we can disambiguate labels
  // when multiple plans have the same `durationInMonths`.
  const durationCounts = sortedPlans.reduce<Record<number, number>>(
    (acc, plan) => {
      acc[plan.durationInMonths] = (acc[plan.durationInMonths] || 0) + 1;
      return acc;
    },
    {},
  );
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

  const durationSeen: Record<number, number> = {};
  const tabLabels = sortedPlans.map((plan) => {
    const base = `${plan.durationInMonths} Mo`;
    if (durationCounts[plan.durationInMonths] > 1) {
      durationSeen[plan.durationInMonths] =
        (durationSeen[plan.durationInMonths] || 0) + 1;
      return `${base} (${durationSeen[plan.durationInMonths]})`;
    }
    return base;
  });

  return (
    <div className="bg-card rounded-2xl border border-border hover:border-border hover:shadow-xl transition-all duration-300 overflow-hidden group">
      <div className="p-6 md:p-8 lg:p-10 flex flex-col lg:flex-row gap-8 lg:gap-12">
        {/* Left Section: Consultant Info. Uses a stretched overlay <Link>
            (absolute inset-0) instead of wrapping the whole section, so the
            nested org-badge link stays valid HTML (no <a> inside <a>) while
            right-click / cmd-click / middle-click still open the profile. */}
        <div className="relative flex-grow">
          <Link
            href={profileHref}
            aria-label={`View ${consultant.user.name}'s profile`}
            className="absolute inset-0 z-0"
          />
          {/* Header */}
          <div className="flex items-start gap-4 mb-6">
            <div className="relative h-20 w-20 flex-shrink-0">
              <Image
                alt={`Portrait of ${consultant.user.name}`}
                className="rounded-2xl object-cover ring-2 ring-muted"
                src={consultant.user.image || "/placeholder-user.jpg"}
                fill
                // 80×80 slot — without sizes, `fill` fetches a 100vw image (#932 perf).
                sizes="80px"
              />
              {/* TODO: Add real presence indicator when online tracking is implemented */}
            </div>
            <div className="flex-1 min-w-0">
              {/* Name and org badge share one row, so neither may wrap: a long
                  org name ("Indian Institute of Technology Madras") otherwise
                  breaks onto a second line and squeezes the name into wrapping
                  too. Both truncate instead, and the badge keeps its `title`
                  so the full name is still reachable on hover. */}
              <div className="flex items-center gap-1.5 min-w-0">
                <h3 className="truncate text-xl font-bold text-foreground group-hover:text-muted-foreground transition-colors">
                  {consultant.user.name}
                </h3>
                {consultant.isVerified && (
                  <span title="Verified by Familiarise" className="shrink-0">
                    {/* Verification is an attribute, not a semantic status —
                        the off-brand blue was the only chromatic accent here. */}
                    <BadgeCheck className="w-5 h-5 text-foreground" />
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
                      className="max-w-[180px] whitespace-nowrap border-border text-foreground text-[10px] px-1.5 py-0 hover:bg-muted transition-colors"
                    >
                      <Building2 className="w-3 h-3 mr-0.5 shrink-0" />
                      <span className="truncate">
                        {consultant.organizationBadge.name}
                      </span>
                    </Badge>
                  </Link>
                )}
              </div>
              {/* #705 — a null score means too few rated sessions to publish
                  one. Say that rather than printing 0.0, which reads as a bad
                  consultant instead of a new one. */}
              <div className="flex items-center gap-2 mt-2">
                {consultant.rating !== null ? (
                  <>
                    <div className="flex items-center gap-1">
                      <Star className="w-4 h-4 text-amber-400 fill-amber-400" />
                      <span className="font-semibold text-foreground">
                        {consultant.rating.toFixed(1)}
                      </span>
                    </div>
                    <span className="text-muted-foreground/70">•</span>
                  </>
                ) : null}
                <span className="text-sm text-muted-foreground">
                  {consultant.reviewCount ?? consultant.reviews?.length ?? 0}{" "}
                  reviews
                </span>
              </div>
            </div>
          </div>

          {/* Description — only render when it's meaningful free-form text */}
          {isMeaningfulText(consultant.description) && (
            <p className="text-muted-foreground leading-relaxed mb-6 line-clamp-2">
              {consultant.description.trim()}
            </p>
          )}

          {/* Meta Info */}
          <div className="space-y-3 mb-6">
            {/* Headline - first line */}
            <ConsultantInfo
              icon={Briefcase}
              label="Headline"
              value={consultant.headline}
            />
            {/* Experience and Domain - second line together */}
            <div className="flex items-center gap-6">
              <ConsultantInfo
                icon={Clock}
                label="Experience"
                value={
                  consultant.experience
                    ? `${consultant.experience} years`
                    : null
                }
              />
              {/* Domain moved to the labelled badge row below — it was stated
                  twice, once here and once as the first badge. */}
            </div>
            {/* Languages */}
            {consultant.languages && consultant.languages.length > 0 && (
              <ConsultantInfo
                icon={Globe}
                label="Languages"
                value={consultant.languages.join(", ")}
              />
            )}
          </div>

          {/* Company Logos */}
          {consultant.user.workExperiences &&
            consultant.user.workExperiences.length > 0 && (
              <div className="flex items-center gap-2 mb-4">
                {consultant.user.workExperiences.slice(0, 3).map((exp, i) => (
                  <CompanyLogo
                    key={`${consultant.id}-company-${i}`}
                    companyName={exp.company}
                    companyDomain={exp.companyDomain ?? undefined}
                    size={36}
                    className="border-border"
                  />
                ))}
                <span className="text-sm text-muted-foreground ml-1">
                  {consultant.user.workExperiences[0].company}
                  {consultant.user.workExperiences.length > 1 &&
                    ` +${consultant.user.workExperiences.length - 1}`}
                </span>
              </div>
            )}

          {/* Domain & Subdomains. Labelled rather than a bare run of pills:
              domain, subdomain and skill badges are visually interchangeable,
              so without a label the reader can't tell which taxonomy they're
              looking at. */}
          {(consultant.domain?.name || consultant.subDomains.length > 0) && (
            <BadgeRow label="Domain">
              {consultant.domain?.name && (
                <Badge className="bg-primary text-primary-foreground hover:bg-primary/90 px-3 py-1">
                  {consultant.domain.name}
                </Badge>
              )}
              {consultant.subDomains.slice(0, 2).map((sd) => (
                <Badge
                  key={`${consultant.id}-subdomain-${sd.id}`}
                  variant="outline"
                  className="border-border text-muted-foreground px-3 py-1"
                >
                  {sd.name}
                </Badge>
              ))}
            </BadgeRow>
          )}

          {/* Tags */}
          {consultant.tags.length > 0 && (
            <BadgeRow label="Skills">
              {consultant.tags.slice(0, 3).map((t) => (
                <Badge
                  key={`${consultant.id}-tag-${t.id}`}
                  className="bg-muted text-muted-foreground hover:bg-muted/80 px-3 py-1"
                >
                  {t.name}
                </Badge>
              ))}
            </BadgeRow>
          )}
        </div>

        {/* Right Section: Subscription Plans & Actions */}
        <div className="flex-shrink-0 lg:w-[380px] xl:w-[420px] space-y-4">
          <div className="bg-muted rounded-xl p-4">
            {sortedPlans.length > 0 ? (
              <Tabs defaultValue={sortedPlans[0].id} className="w-full">
                <TabsList className="w-full mb-4 bg-card p-1 rounded-lg border border-border">
                  {sortedPlans.map((plan, index) => (
                    <TabsTrigger
                      key={`${consultant.id}-tab-trigger-${plan.id}`}
                      value={plan.id}
                      className="flex-1 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-md text-sm font-medium transition-all duration-200"
                    >
                      {tabLabels[index]}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {sortedPlans.map((plan) => (
                  <TabsContent
                    key={`${consultant.id}-tab-content-${plan.id}`}
                    value={plan.id}
                  >
                    <SubscriptionPlanCard
                      plan={plan}
                      formatPrice={formatPrice}
                    />
                  </TabsContent>
                ))}
              </Tabs>
            ) : (
              <div className="text-center text-muted-foreground py-8">
                <p className="text-sm">No subscription plans available</p>
              </div>
            )}
          </div>

          {/* Action Buttons — wrapped in <Link> via Button asChild so the
              browser context menu offers "Open in new tab" / "Copy link". */}
          <div className="flex flex-col gap-2">
            <Button
              asChild
              className="w-full h-12 bg-primary hover:bg-primary/90 text-primary-foreground font-medium rounded-xl transition-all"
            >
              <Link href={profileHref}>
                <span>View Profile</span>
                <ArrowRight className="w-4 h-4 ml-2" />
              </Link>
            </Button>
            <div
              className={`grid gap-2 ${trialOffer ? "grid-cols-2" : "grid-cols-1"}`}
            >
              {trialOffer && (
                <Button
                  asChild
                  variant="outline"
                  className="h-10 border-border hover:bg-muted text-muted-foreground rounded-xl text-sm font-medium"
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
                className="h-10 border-border hover:bg-muted text-muted-foreground rounded-xl text-sm font-medium"
              >
                <Link href={`${profileHref}?action=book`}>Book Session</Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
