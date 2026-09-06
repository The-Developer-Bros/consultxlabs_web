"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";

interface SectionHeaderProps {
  title: string;
  description?: string;
  /** Optional result count, rendered as a chip beside the title. */
  count?: number;
  seeAllHref?: string;
  onSeeAllClick?: () => void;
  seeAllLabel?: string;
}

const SEE_ALL_CLASSNAME =
  "group inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline";

export default function SectionHeader({
  title,
  description,
  count,
  seeAllHref,
  onSeeAllClick,
  seeAllLabel = "See all",
}: SectionHeaderProps) {
  const seeAllContent = (
    <>
      {seeAllLabel}
      <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
    </>
  );

  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight text-foreground md:text-2xl">
          {title}
          {count !== undefined && (
            <span className="ml-2 inline-flex items-center rounded-full border border-border bg-background px-2.5 py-1 align-middle text-xs font-medium tabular-nums text-muted-foreground">
              {count}
            </span>
          )}
        </h2>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>

      {onSeeAllClick ? (
        <button
          type="button"
          onClick={onSeeAllClick}
          className={SEE_ALL_CLASSNAME}
        >
          {seeAllContent}
        </button>
      ) : (
        seeAllHref && (
          <Link href={seeAllHref} className={SEE_ALL_CLASSNAME}>
            {seeAllContent}
          </Link>
        )
      )}
    </div>
  );
}
