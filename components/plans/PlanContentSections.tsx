"use client";

import { useState } from "react";
import { ChevronDown, CheckCircle2, Target, Package } from "lucide-react";
import { groupCurriculumBySection } from "@/lib/labels/plan-labels";
import { cn } from "@/utils/tailwind";

/**
 * Buyer-facing renderers for the plan content model.
 *
 * Shared by the subscription detail modal, the consultation pricing toggle and
 * the class/webinar detail pages, so "Who this is for" reads the same wherever
 * a buyer meets it. Every section returns null when its data is empty — the
 * detail pages previously rendered an empty bordered card with just a heading
 * whenever a consultant had not filled a field in.
 */

export type CurriculumItem = {
  id?: string;
  title: string;
  description: string;
  order: number;
  hoursAllotted?: number;
  contentType?: string | null;
  sectionLabel?: string | null;
  outcomes?: string[];
};

export function BulletList({
  items,
  title,
  icon: Icon,
  className,
}: Readonly<{
  items: string[] | null | undefined;
  title: string;
  icon?: typeof Target;
  className?: string;
}>) {
  if (!items?.length) return null;
  return (
    <div className={className}>
      <h3 className="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
        {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
        {title}
      </h3>
      <ul className="grid sm:grid-cols-2 gap-2.5">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
            <span className="text-sm text-muted-foreground">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TargetAudience({
  items,
  className,
}: Readonly<{ items: string[] | null | undefined; className?: string }>) {
  return (
    <BulletList
      items={items}
      title="Who this is for"
      icon={Target}
      className={className}
    />
  );
}

export function WhatsIncluded({
  items,
  className,
}: Readonly<{ items: string[] | null | undefined; className?: string }>) {
  return (
    <BulletList
      items={items}
      title="What's included"
      icon={Package}
      className={className}
    />
  );
}

/**
 * The week-by-week roadmap.
 *
 * Items are grouped by `sectionLabel` so "Week 1" covering two sessions renders
 * as one heading, which is the shape competitors use and the reason the column
 * exists. Unlabelled items fall through to a plain numbered list.
 */
export function CurriculumOutline({
  items,
  title = "What we'll cover",
  className,
}: Readonly<{
  items: CurriculumItem[] | null | undefined;
  title?: string;
  className?: string;
}>) {
  if (!items?.length) return null;
  const groups = groupCurriculumBySection(items);
  const totalHours = items.reduce(
    (sum, item) => sum + (item.hoursAllotted ?? 0),
    0,
  );

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {items.length} session{items.length !== 1 ? "s" : ""}
          {totalHours > 0 && ` · ${totalHours}h total`}
        </span>
      </div>

      <div className="space-y-3">
        {groups.map((group, groupIndex) => (
          <div key={group.label ?? `group-${groupIndex}`}>
            {group.label && (
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                {group.label}
              </p>
            )}
            <div className="space-y-2">
              {group.items.map((item) => (
                <div
                  key={item.id ?? `${item.order}-${item.title}`}
                  className="flex items-start gap-3 p-3 bg-muted rounded-xl"
                >
                  <div className="w-7 h-7 rounded-lg bg-primary text-primary-foreground flex items-center justify-center font-semibold text-xs flex-shrink-0">
                    {item.order}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <h4 className="font-medium text-sm text-foreground">
                        {item.title}
                      </h4>
                      {item.hoursAllotted ? (
                        <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                          {item.hoursAllotted}h
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {item.description}
                    </p>
                    {item.outcomes && item.outcomes.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {item.outcomes.map((outcome) => (
                          <li
                            key={outcome}
                            className="flex items-start gap-2 text-[11px] text-muted-foreground"
                          >
                            <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0 mt-0.5" />
                            {outcome}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export type PlanFaqItem = {
  id?: string;
  question: string;
  answer: string;
  order?: number;
};

export function PlanFaqAccordion({
  faqs,
  className,
}: Readonly<{ faqs: PlanFaqItem[] | null | undefined; className?: string }>) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  if (!faqs?.length) return null;

  return (
    <div className={className}>
      <h3 className="text-base font-semibold text-foreground mb-3">
        Frequently asked questions
      </h3>
      <div className="divide-y divide-border border border-border rounded-xl overflow-hidden">
        {faqs.map((faq, index) => {
          const isOpen = openIndex === index;
          return (
            <div key={faq.id ?? `${index}-${faq.question}`}>
              <button
                type="button"
                onClick={() => setOpenIndex(isOpen ? null : index)}
                aria-expanded={isOpen}
                className="w-full flex items-center justify-between gap-3 text-left px-4 py-3 hover:bg-muted/50 transition-colors"
              >
                <span className="text-sm font-medium text-foreground">
                  {faq.question}
                </span>
                <ChevronDown
                  className={cn(
                    "w-4 h-4 text-muted-foreground flex-shrink-0 transition-transform",
                    isOpen && "rotate-180",
                  )}
                />
              </button>
              {isOpen && (
                <p className="px-4 pb-4 text-sm text-muted-foreground whitespace-pre-line">
                  {faq.answer}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
