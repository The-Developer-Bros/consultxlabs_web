import type { PlanLevel } from "@prisma/client";
import {
  groupCurriculumBySection,
  planLevelLabel,
  sortPlanLevels,
} from "@/lib/labels/plan-labels";

const LEVELS: PlanLevel[] = [
  "BEGINNER",
  "INTERMEDIATE",
  "ADVANCED",
  "ALL_LEVELS",
];

describe("planLevelLabel", () => {
  it("renders every enum member as prose, never the raw value", () => {
    for (const level of LEVELS) {
      const label = planLevelLabel(level);
      expect(label).not.toBe(level);
      expect(label).not.toMatch(/_/);
    }
  });

  it("falls back for a missing level rather than printing undefined", () => {
    expect(planLevelLabel(null)).toBe("All levels");
    expect(planLevelLabel(undefined)).toBe("All levels");
  });
});

describe("sortPlanLevels", () => {
  it("sorts in teaching order, not alphabetical order", () => {
    // localeCompare would give ADVANCED, ALL_LEVELS, BEGINNER, INTERMEDIATE.
    expect(
      sortPlanLevels([
        "ADVANCED" as PlanLevel,
        "BEGINNER" as PlanLevel,
        "ALL_LEVELS" as PlanLevel,
        "INTERMEDIATE" as PlanLevel,
      ]),
    ).toEqual([
      "BEGINNER" as PlanLevel,
      "INTERMEDIATE" as PlanLevel,
      "ADVANCED" as PlanLevel,
      "ALL_LEVELS" as PlanLevel,
    ]);
  });
});

describe("groupCurriculumBySection", () => {
  const item = (order: number, sectionLabel?: string | null) => ({
    order,
    sectionLabel,
    title: `Session ${order}`,
  });

  it("collapses adjacent items that share a label into one group", () => {
    const groups = groupCurriculumBySection([
      item(1, "Week 1"),
      item(2, "Week 1"),
      item(3, "Week 2"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe("Week 1");
    expect(groups[0].items.map((i) => i.order)).toEqual([1, 2]);
    expect(groups[1].items.map((i) => i.order)).toEqual([3]);
  });

  it("orders by `order`, not by input order", () => {
    const groups = groupCurriculumBySection([
      item(3, "Week 2"),
      item(1, "Week 1"),
      item(2, "Week 1"),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Week 1", "Week 2"]);
    expect(groups[0].items.map((i) => i.order)).toEqual([1, 2]);
  });

  it("does NOT merge a repeated label back into an earlier group", () => {
    // Merging non-adjacent groups would move session 3 above session 2 and
    // silently reorder the roadmap the consultant authored.
    const groups = groupCurriculumBySection([
      item(1, "Week 1"),
      item(2, "Week 2"),
      item(3, "Week 1"),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.items[0].order)).toEqual([1, 2, 3]);
  });

  it("keeps unlabelled items as their own groups so legacy plans still render", () => {
    const groups = groupCurriculumBySection([item(1), item(2)]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.label === null)).toBe(true);
  });

  it("treats a whitespace-only label as absent", () => {
    const groups = groupCurriculumBySection([item(1, "   "), item(2, null)]);
    expect(groups.every((g) => g.label === null)).toBe(true);
  });

  it("returns an empty array for no items", () => {
    expect(groupCurriculumBySection([])).toEqual([]);
  });
});
