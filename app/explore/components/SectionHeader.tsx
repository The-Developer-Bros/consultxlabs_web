"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";

interface SectionHeaderProps {
  title: string;
  /** One-line salesy subhead rendered under the title. */
  subtitle?: string;
  seeAllHref?: string;
  onSeeAllClick?: () => void;
  icon?: React.ReactNode;
}

export default function SectionHeader({
  title,
  subtitle,
  seeAllHref,
  onSeeAllClick,
  icon,
}: SectionHeaderProps) {
  const showSeeAll = seeAllHref || onSeeAllClick;

  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          {icon && (
            <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center shrink-0">
              {icon}
            </div>
          )}
          <h2 className="text-xl md:text-2xl font-bold text-foreground tracking-tight">{title}</h2>
        </div>
        {subtitle && (
          <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {showSeeAll &&
        (onSeeAllClick ? (
          <button
            onClick={onSeeAllClick}
            className="group inline-flex shrink-0 self-center items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            See All
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </button>
        ) : (
          <Link
            href={seeAllHref!}
            className="group inline-flex shrink-0 self-center items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            See All
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </Link>
        ))}
    </div>
  );
}
