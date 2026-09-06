import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { CompanyLogo } from "@/components/ui/company-logo";
import type { ICollaboratorInfo } from "../types";

interface PlanExpert {
  id: string;
  headline?: string | null;
  experience?: number | null;
  user?: {
    name?: string | null;
    image?: string | null;
    workExperiences?: { company: string; companyDomain: string | null }[];
  } | null;
}

interface PlanExpertCardProps {
  /** "Your instructor", "Your host", "Your expert", "Your mentor". */
  heading: string;
  expert: PlanExpert | null | undefined;
  collaboratorsHeading: string;
  collaborators?: ICollaboratorInfo[];
}

function experienceLabel(years: number | null | undefined): string | null {
  if (!years || years <= 0) return null;
  const n = Number.isInteger(years) ? years : years.toFixed(1);
  return `${n} yrs experience`;
}

/**
 * The person behind the plan, in the sidebar of every plan detail page.
 *
 * Renders only what the profile actually says. The four pages used to share a
 * hardcoded sentence ("An experienced professional dedicated to sharing
 * knowledge and expertise.") under every instructor; a headline the expert
 * wrote, or nothing, is the honest version.
 */
export function PlanExpertCard({
  heading,
  expert,
  collaboratorsHeading,
  collaborators,
}: Readonly<PlanExpertCardProps>) {
  if (!expert) return null;

  const name = expert.user?.name ?? "Expert";
  const href = `/explore/experts/${expert.id}`;
  const experience = experienceLabel(expert.experience);
  const logos = (expert.user?.workExperiences ?? []).slice(0, 3);

  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {heading}
      </p>

      <Link href={href} className="group mt-4 flex items-start gap-4">
        <span className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl ring-1 ring-border">
          <Image
            src={expert.user?.image ?? "/placeholder-user.jpg"}
            alt=""
            fill
            sizes="56px"
            className="object-cover"
          />
        </span>
        <span className="min-w-0">
          <span className="block font-semibold text-foreground underline-offset-4 group-hover:underline">
            {name}
          </span>
          {expert.headline && (
            <span className="mt-0.5 line-clamp-2 block text-sm text-muted-foreground">
              {expert.headline}
            </span>
          )}
          {experience && (
            <span className="mt-1 block text-xs text-muted-foreground">
              {experience}
            </span>
          )}
        </span>
      </Link>

      {logos.length > 0 && (
        <div className="mt-4 flex items-center gap-1.5">
          {logos.map((exp, i) => (
            <CompanyLogo
              key={`${expert.id}-company-${i}`}
              companyName={exp.company}
              companyDomain={exp.companyDomain ?? undefined}
              size={24}
              className="border-border"
            />
          ))}
        </div>
      )}

      <Link
        href={href}
        className="group mt-5 inline-flex items-center gap-1 text-sm font-medium text-foreground underline-offset-4 hover:underline"
      >
        View full profile
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </Link>

      {collaborators && collaborators.length > 0 && (
        <div className="mt-6 border-t border-border pt-5">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            {collaboratorsHeading}
          </p>
          <ul className="mt-3 space-y-1">
            {collaborators.map((collab) => (
              <li key={collab.id}>
                <Link
                  href={`/explore/experts/${collab.consultantProfile.id}`}
                  className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted"
                >
                  <span className="relative h-8 w-8 shrink-0 overflow-hidden rounded-full ring-1 ring-border">
                    <Image
                      src={
                        collab.consultantProfile.user.image ??
                        "/placeholder-user.jpg"
                      }
                      alt=""
                      fill
                      sizes="32px"
                      className="object-cover"
                    />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {collab.consultantProfile.user.name}
                    </span>
                    <span className="block text-xs capitalize text-muted-foreground">
                      {collab.role.toLowerCase().replace(/_/g, " ")}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
