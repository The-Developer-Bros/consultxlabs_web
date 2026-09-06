import { Check } from "lucide-react";

import {
  CurriculumOutline,
  PlanFaqAccordion,
  TargetAudience,
  WhatsIncluded,
  type CurriculumItem,
  type PlanFaqItem,
} from "@/components/plans/PlanContentSections";

/**
 * The content column shared by all four plan detail pages.
 *
 * Class and webinar detail were already near-duplicates of each other; adding
 * subscription and consultation as two more copies would have quadrupled the
 * drift surface and pushed the duplication gate further out. Each page keeps
 * its own hero, facts grid and booking sidebar — the parts that genuinely
 * differ per type — and composes this for everything in between.
 *
 * Every section returns null when empty, so a sparsely-authored plan renders a
 * short page rather than a run of empty bordered cards with headings.
 */
export interface PlanDetailBodyProps {
  aboutHeading: string;
  description?: string | null;
  learningOutcomes?: string[];
  targetAudience?: string[];
  whatsIncluded?: string[];
  curriculum?: CurriculumItem[] | null;
  curriculumHeading?: string;
  prerequisites?: string | null;
  materialProvided?: string | null;
  faqs?: PlanFaqItem[] | null;
  topics?: { id: string; name: string }[];
}

function SectionCard({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <section className="rounded-2xl border border-border bg-card p-6 md:p-8">
      {children}
    </section>
  );
}

function SectionTitle({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <h2 className="mb-4 text-lg font-semibold tracking-tight text-foreground">
      {children}
    </h2>
  );
}

export function PlanDetailBody({
  aboutHeading,
  description,
  learningOutcomes,
  targetAudience,
  whatsIncluded,
  curriculum,
  curriculumHeading = "What we'll cover",
  prerequisites,
  materialProvided,
  faqs,
  topics,
}: Readonly<PlanDetailBodyProps>) {
  // "None" is the historical default on prerequisites/materialProvided, so it
  // means "nothing to say" rather than a value worth giving a card to.
  const hasPrerequisites = prerequisites && prerequisites !== "None";
  const hasMaterials = materialProvided && materialProvided !== "None";
  const hasPositioning =
    (targetAudience?.length ?? 0) > 0 || (whatsIncluded?.length ?? 0) > 0;

  return (
    <>
      {description && (
        <SectionCard>
          <SectionTitle>{aboutHeading}</SectionTitle>
          <p className="whitespace-pre-line leading-relaxed text-muted-foreground">
            {description}
          </p>
        </SectionCard>
      )}

      {hasPositioning && (
        <SectionCard>
          <div className="space-y-6">
            <TargetAudience items={targetAudience} />
            <WhatsIncluded items={whatsIncluded} />
          </div>
        </SectionCard>
      )}

      {(learningOutcomes?.length ?? 0) > 0 && (
        <SectionCard>
          <SectionTitle>What you&apos;ll learn</SectionTitle>
          <ul className="grid gap-3 md:grid-cols-2">
            {learningOutcomes!.map((outcome) => (
              <li
                key={outcome}
                className="flex items-start gap-3 text-sm text-muted-foreground"
              >
                <Check
                  className="mt-0.5 h-4 w-4 shrink-0 text-foreground"
                  strokeWidth={2}
                />
                {outcome}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {(curriculum?.length ?? 0) > 0 && (
        <SectionCard>
          <CurriculumOutline items={curriculum} title={curriculumHeading} />
        </SectionCard>
      )}

      {hasPrerequisites && (
        <SectionCard>
          <SectionTitle>Prerequisites</SectionTitle>
          <p className="whitespace-pre-line text-muted-foreground">
            {prerequisites}
          </p>
        </SectionCard>
      )}

      {hasMaterials && (
        <SectionCard>
          <SectionTitle>Materials provided</SectionTitle>
          <p className="whitespace-pre-line text-muted-foreground">
            {materialProvided}
          </p>
        </SectionCard>
      )}

      {(faqs?.length ?? 0) > 0 && (
        <SectionCard>
          <PlanFaqAccordion faqs={faqs} />
        </SectionCard>
      )}

      {(topics?.length ?? 0) > 0 && (
        <SectionCard>
          <SectionTitle>Topics covered</SectionTitle>
          <div className="flex flex-wrap gap-2">
            {topics!.map((topic) => (
              <span
                key={topic.id}
                className="inline-flex items-center rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground"
              >
                {topic.name}
              </span>
            ))}
          </div>
        </SectionCard>
      )}
    </>
  );
}
