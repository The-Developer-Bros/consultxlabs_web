/**
 * Shared user-facing labels for the offering (plan) vocabulary.
 *
 * `PlanLevel` replaced a free-text `level String` on all four plan models, so
 * every surface that used to print whatever the consultant typed now holds an
 * enum member. Rendering those raw would put `ALL_LEVELS` in front of buyers —
 * the raw-enum leak issue #487 catalogues across the dashboard. Everything that
 * shows a level pulls its copy from here instead.
 *
 * `PLAN_LEVEL_ORDER` exists because the levels have a pedagogical sequence that
 * neither alphabetical nor enum-declaration order reproduces: a facet sorted
 * with `localeCompare` reads Advanced, All levels, Beginner, Intermediate.
 */

// Type-only: a label table has no business pulling the Prisma client runtime
// into every consumer (it breaks jsdom tests, which have no TextEncoder).
import type { PlanLevel } from "@prisma/client";

export const PLAN_LEVEL_LABEL: Record<PlanLevel, string> = {
  BEGINNER: "Beginner",
  INTERMEDIATE: "Intermediate",
  ADVANCED: "Advanced",
  ALL_LEVELS: "All levels",
};

/** Easiest to hardest, with the catch-all last. */
export const PLAN_LEVEL_ORDER: PlanLevel[] = [
  "BEGINNER",
  "INTERMEDIATE",
  "ADVANCED",
  "ALL_LEVELS",
];

export function planLevelLabel(level: PlanLevel | null | undefined): string {
  return level ? PLAN_LEVEL_LABEL[level] : "All levels";
}

/** Sorts a level list into teaching order rather than alphabetical order. */
export function sortPlanLevels(levels: PlanLevel[]): PlanLevel[] {
  return [...levels].sort(
    (a, b) => PLAN_LEVEL_ORDER.indexOf(a) - PLAN_LEVEL_ORDER.indexOf(b),
  );
}

/**
 * Groups curriculum items under their `sectionLabel`, preserving `order`.
 *
 * Items sharing a label collapse into one heading ("Week 1" covering two
 * sessions); items with no label fall into a single unlabelled group so a plan
 * authored before labels existed still renders as a flat ordered list.
 */
export function groupCurriculumBySection<
  T extends { order: number; sectionLabel?: string | null },
>(items: T[]): { label: string | null; items: T[] }[] {
  const ordered = [...items].sort((a, b) => a.order - b.order);
  const groups: { label: string | null; items: T[] }[] = [];

  for (const item of ordered) {
    const label = item.sectionLabel?.trim() || null;
    const last = groups.at(-1);
    // Only merge into the immediately preceding group. Matching any earlier
    // group would let a repeated label pull a later session backwards and
    // silently reorder the roadmap.
    if (last && last.label === label && label !== null) {
      last.items.push(item);
    } else {
      groups.push({ label, items: [item] });
    }
  }

  return groups;
}
