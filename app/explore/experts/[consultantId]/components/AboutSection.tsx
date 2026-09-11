"use client";

import { User } from "@prisma/client";
import type { ConsultantDetailData } from "../types";
import { User2, GraduationCap, Sparkles } from "lucide-react";

interface AboutSectionProps {
  userDetails: User;
  consultantDetails: ConsultantDetailData;
}

/**
 * Returns true if `value` is a non-empty string that isn't one of the
 * placeholder sentinels users/seeds sometimes leave behind ("none", "n/a", …).
 */
const isRealDescription = (
  value: string | null | undefined,
): value is string => {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return !/^(none|n\/?a|na|null|nil|tbd|-+|\.+)$/i.test(trimmed);
};

export function AboutSection({
  userDetails,
  consultantDetails,
}: AboutSectionProps) {
  return (
    <div className="bg-card rounded-2xl border border-border p-6 md:p-8 space-y-6">
      {/* About */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
            <User2 className="w-4 h-4 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold text-foreground">About</h3>
        </div>
        <p className="text-muted-foreground leading-relaxed">
          {isRealDescription(consultantDetails.description) ? (
            consultantDetails.description.trim()
          ) : (
            <>
              {userDetails.name} is a seasoned{" "}
              {consultantDetails.headline || consultantDetails.domain.name}{" "}
              expert with {consultantDetails.experience} of experience in the{" "}
              {consultantDetails.domain.name} sector. They specialize in helping
              professionals and businesses achieve their goals through expert
              guidance and mentorship.
            </>
          )}
        </p>
      </div>

      {/* Education & Background */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
            <GraduationCap className="w-4 h-4 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold text-foreground">
            Education & Background
          </h3>
        </div>
        <p className="text-muted-foreground leading-relaxed">
          {userDetails.name} has extensive experience across multiple
          industries, with a particular focus on{" "}
          {consultantDetails?.subDomains
            ?.map((domain: { name: string }) => domain.name)
            .join(", ") || consultantDetails.domain.name}
          . Their background includes working with diverse clients and
          organizations to deliver measurable results.
        </p>
      </div>

      {/* Skills & Specialties */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold text-foreground">
            Skills & Specialties
          </h3>
        </div>
        <div className="flex flex-wrap gap-2">
          {consultantDetails.tags?.map((tag: { id: string; name: string }) => (
            <span
              key={tag.id}
              className="px-3 py-1.5 bg-muted text-muted-foreground text-sm font-medium rounded-full"
            >
              {tag.name}
            </span>
          ))}
          {(!consultantDetails.tags || consultantDetails.tags.length === 0) && (
            <p className="text-muted-foreground text-sm">
              Specializes in{" "}
              {consultantDetails.headline || consultantDetails.domain.name}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
