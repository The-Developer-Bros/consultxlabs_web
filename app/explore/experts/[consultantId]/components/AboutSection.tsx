"use client";

import { User } from "@prisma/client";
import type { ConsultantDetailData } from "../types";

interface AboutSectionProps {
  userDetails: User;
  consultantDetails: ConsultantDetailData;
}

/**
 * Returns true if `value` is a non-empty string that isn't one of the
 * placeholder sentinels users/seeds sometimes leave behind ("none", "n/a", …).
 */
const isRealText = (value: string | null | undefined): value is string => {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return !/^(none|n\/?a|na|null|nil|tbd|-+|\.+)$/i.test(trimmed);
};

const CHIP =
  "inline-flex items-center rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground";

function Block({
  title,
  children,
}: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </div>
  );
}

/**
 * What the expert has said about themselves, and nothing else.
 *
 * This section used to fill every gap with a templated paragraph ("X is a
 * seasoned … expert with N of experience", "has extensive experience across
 * multiple industries") that no expert had written. A profile with nothing to
 * say now says nothing; the section disappears entirely when every field is
 * empty.
 */
export function AboutSection({
  userDetails,
  consultantDetails,
}: AboutSectionProps) {
  const about = isRealText(consultantDetails.description)
    ? consultantDetails.description.trim()
    : isRealText(userDetails.bio)
      ? userDetails.bio.trim()
      : null;
  const mentoringStyle = isRealText(consultantDetails.mentoringStyle)
    ? consultantDetails.mentoringStyle.trim()
    : null;
  const tags = consultantDetails.tags ?? [];
  const tools = consultantDetails.toolsAndTechnologies ?? [];

  if (!about && !mentoringStyle && tags.length === 0 && tools.length === 0) {
    return null;
  }

  return (
    <section className="space-y-8 rounded-2xl border border-border bg-card p-6 md:p-8">
      {about && (
        <Block title="About">
          <p className="whitespace-pre-line leading-relaxed text-muted-foreground">
            {about}
          </p>
        </Block>
      )}

      {mentoringStyle && (
        <Block title="How they mentor">
          <p className="whitespace-pre-line leading-relaxed text-muted-foreground">
            {mentoringStyle}
          </p>
        </Block>
      )}

      {tags.length > 0 && (
        <Block title="Skills and specialties">
          <div className="flex flex-wrap gap-2">
            {tags.map((tag: { id: string; name: string }) => (
              <span key={tag.id} className={CHIP}>
                {tag.name}
              </span>
            ))}
          </div>
        </Block>
      )}

      {tools.length > 0 && (
        <Block title="Tools and technologies">
          <div className="flex flex-wrap gap-2">
            {tools.map((tool) => (
              <span key={tool} className={CHIP}>
                {tool}
              </span>
            ))}
          </div>
        </Block>
      )}
    </section>
  );
}
