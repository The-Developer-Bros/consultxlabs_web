"use client";

import Image from "next/image";
import {
  BadgeCheck,
  Github,
  Globe,
  Linkedin,
  MapPin,
  Star,
  Twitter,
  type LucideIcon,
} from "lucide-react";
import { User } from "@prisma/client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { ConsultantDetailData } from "../types";

interface ProfileHeaderProps {
  userDetails: User;
  consultantDetails: ConsultantDetailData;
  reviewCount: number;
}

const CHIP =
  "inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground";

function experienceLabel(years: number | null | undefined): string | null {
  if (!years || years <= 0) return null;
  const n = Number.isInteger(years) ? years : years.toFixed(1);
  return `${n} yrs experience`;
}

export function ProfileHeader({
  userDetails,
  consultantDetails,
  reviewCount,
}: ProfileHeaderProps) {
  const name = userDetails.name ?? "Expert";
  const location = [userDetails.city, userDetails.country]
    .filter(Boolean)
    .join(", ");
  const experience = experienceLabel(consultantDetails.experience);
  const languages = consultantDetails.languages ?? [];

  const socials: { href: string; label: string; icon: LucideIcon }[] = [];
  if (userDetails.linkedinUrl)
    socials.push({
      href: userDetails.linkedinUrl,
      label: "LinkedIn",
      icon: Linkedin,
    });
  if (consultantDetails.twitterUrl)
    socials.push({
      href: consultantDetails.twitterUrl,
      label: "Twitter",
      icon: Twitter,
    });
  if (consultantDetails.githubUrl)
    socials.push({
      href: consultantDetails.githubUrl,
      label: "GitHub",
      icon: Github,
    });
  if (consultantDetails.websiteUrl)
    socials.push({
      href: consultantDetails.websiteUrl,
      label: "Website",
      icon: Globe,
    });

  return (
    <header className="rounded-2xl border border-border bg-card p-6 md:p-8">
      <div className="flex flex-col gap-6 sm:flex-row">
        <div className="shrink-0">
          {userDetails.profileDisplayImage ? (
            <div className="relative h-32 w-32 overflow-hidden rounded-2xl ring-1 ring-border md:h-40 md:w-40">
              <Image
                src={userDetails.profileDisplayImage}
                alt={name}
                fill
                priority
                sizes="(max-width: 768px) 128px, 160px"
                className="object-cover"
              />
            </div>
          ) : (
            <Avatar className="h-28 w-28 ring-1 ring-border md:h-32 md:w-32">
              <AvatarImage
                src={userDetails.image || "/placeholder-user.jpg"}
                alt={name}
                className="object-cover"
              />
              <AvatarFallback className="bg-muted text-2xl font-semibold text-foreground">
                {name.charAt(0)}
              </AvatarFallback>
            </Avatar>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            {consultantDetails.domain.name}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h1 className="text-fluid-3xl font-semibold tracking-[-0.02em] text-foreground">
              {name}
            </h1>
            {consultantDetails.isVerified && (
              <span
                title="Verified by Familiarise"
                className="inline-flex text-foreground"
              >
                <BadgeCheck
                  className="h-6 w-6"
                  aria-label="Verified by Familiarise"
                />
              </span>
            )}
          </div>
          {consultantDetails.headline && (
            <p className="mt-1.5 text-base text-muted-foreground md:text-lg">
              {consultantDetails.headline}
            </p>
          )}

          {/* Rating. #705 — the PUBLISHED score, which is null until enough
              distinct sessions have been rated. Rendering the raw mean here
              while the reviews section showed the published one would have made
              the threshold decorative. */}
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            {consultantDetails.publishedRating !== null && (
              <>
                <span className="flex items-center gap-1">
                  <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                  <span className="font-semibold tabular-nums text-foreground">
                    {consultantDetails.publishedRating.toFixed(1)}
                  </span>
                </span>
                <span className="text-muted-foreground/60">·</span>
              </>
            )}
            <span className="text-muted-foreground">
              {reviewCount} review{reviewCount !== 1 ? "s" : ""}
            </span>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {experience && <span className={CHIP}>{experience}</span>}
            {location && (
              <span className={CHIP}>
                <MapPin className="h-3 w-3" />
                {location}
              </span>
            )}
            {languages.length > 0 && (
              <span className={CHIP}>
                <Globe className="h-3 w-3" />
                {languages.join(", ")}
              </span>
            )}
            {consultantDetails.subDomains?.map((subdomain) => (
              <span key={subdomain.id} className={CHIP}>
                {subdomain.name}
              </span>
            ))}
            {consultantDetails.tags?.slice(0, 4).map((tag) => (
              <span
                key={tag.id}
                className={`${CHIP} border-transparent bg-muted text-foreground`}
              >
                {tag.name}
              </span>
            ))}
          </div>

          {socials.length > 0 && (
            <div className="mt-5 flex flex-wrap items-center gap-2">
              {socials.map(({ href, label, icon: Icon }) => (
                <a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  title={label}
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                >
                  <Icon className="h-4 w-4" />
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
