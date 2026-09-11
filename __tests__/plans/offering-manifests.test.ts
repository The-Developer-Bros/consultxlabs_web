/**
 * The manifests exist so the four offering types cannot drift apart. These
 * tests assert exactly that — each one corresponds to a real divergence the
 * four hand-built dialogs had accumulated.
 */

import {
  OFFERING_MANIFESTS,
  CLASS_MANIFEST,
  CONSULTATION_MANIFEST,
  SUBSCRIPTION_MANIFEST,
  WEBINAR_MANIFEST,
} from "@/components/offerings/editor/manifests";
import type { FieldSpec, OfferingManifest } from "@/components/offerings/editor/manifest";

const ALL = [
  CONSULTATION_MANIFEST,
  SUBSCRIPTION_MANIFEST,
  WEBINAR_MANIFEST,
  CLASS_MANIFEST,
];

function fieldsOf(manifest: OfferingManifest): FieldSpec[] {
  return manifest.sections.flatMap((s) => s.fields);
}

function fieldNames(manifest: OfferingManifest): string[] {
  return fieldsOf(manifest).map((f) => f.name);
}

function sectionIds(manifest: OfferingManifest): string[] {
  return manifest.sections.map((s) => s.id);
}

describe("offering manifests", () => {
  it("covers all four types", () => {
    expect(Object.keys(OFFERING_MANIFESTS).sort()).toEqual([
      "class",
      "consultation",
      "subscription",
      "webinar",
    ]);
    for (const [key, manifest] of Object.entries(OFFERING_MANIFESTS)) {
      expect(manifest.type).toBe(key);
    }
  });

  it("gives every type a cover image", () => {
    // imageUrl exists on all four Prisma models, but only the webinar and class
    // dialogs ever rendered an uploader — so a consultation could never have a
    // cover image at all.
    for (const manifest of ALL) {
      expect(fieldNames(manifest)).toContain("imageUrl");
    }
  });

  it("gives every type an FAQ", () => {
    for (const manifest of ALL) {
      expect(sectionIds(manifest)).toContain("faq");
    }
  });

  it("offers collaborators only where the model supports them", () => {
    // Co-host / moderator / teaching-assistant roles exist for group events
    // only — CollaboratorsTab's own planType is "webinar" | "class". Showing
    // the section on a 1:1 offering would promise storage that does not exist.
    expect(sectionIds(WEBINAR_MANIFEST)).toContain("collaborators");
    expect(sectionIds(CLASS_MANIFEST)).toContain("collaborators");
    expect(sectionIds(CONSULTATION_MANIFEST)).not.toContain("collaborators");
    expect(sectionIds(SUBSCRIPTION_MANIFEST)).not.toContain("collaborators");
  });

  it("gives every type the same positioning fields", () => {
    // These are what ADR 24 added, and the org catalog silently dropped.
    for (const manifest of ALL) {
      const names = fieldNames(manifest);
      expect(names).toContain("subtitle");
      expect(names).toContain("targetAudience");
      expect(names).toContain("whatsIncluded");
    }
  });

  it("exposes session duration on both recurring types", () => {
    // The class dialog hardcoded this to 1 and never rendered it, so every
    // class was a one-hour-session class while subscriptions could set it.
    for (const manifest of [SUBSCRIPTION_MANIFEST, CLASS_MANIFEST]) {
      expect(fieldNames(manifest)).toContain("sessionDurationInHours");
      expect(fieldNames(manifest)).toContain("sessionsPerWeek");
    }
  });

  it("puts the class start date in the form rather than beside it", () => {
    // It used to be plain useState outside the form with a hand-rolled error.
    expect(fieldNames(CLASS_MANIFEST)).toContain("schedulingStartDate");
  });

  it("keeps every section's fields within one 6-column row width", () => {
    // The dialogs used 2/2/2/3 columns for the same pricing row across the four
    // types. Spans are per-field here, so the only way to be inconsistent is to
    // overflow — which this catches.
    for (const manifest of ALL) {
      for (const section of manifest.sections) {
        for (const field of section.fields) {
          expect([2, 3, 6, undefined]).toContain(field.span);
        }
      }
    }
  });

  it("never declares the same field name twice in one manifest", () => {
    for (const manifest of ALL) {
      const names = fieldNames(manifest);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("gives every slot section an id the editor can look up", () => {
    const slotSections = ALL.flatMap((m) =>
      m.sections.filter((s) => s.slot),
    );

    expect(slotSections.length).toBeGreaterThan(0);
    // A slot section renders bespoke JSX instead of fields, so declaring both
    // would silently drop the fields.
    expect(slotSections.filter((s) => s.fields.length > 0)).toEqual([]);
    expect(slotSections.filter((s) => !/^[a-z]+$/.test(s.slot!))).toEqual([]);
  });

  it("shares the Basics and Content sections verbatim across types", () => {
    // The real regression guard: these are built from shared factories, so a
    // field added to one type's Basics lands on all four. If someone inlines a
    // per-type copy, these lists stop matching.
    const basics = ALL.map((m) =>
      m.sections.find((s) => s.id === "basics")!.fields.map((f) => f.name),
    );
    for (const names of basics) expect(names).toEqual(basics[0]);

    const content = ALL.map((m) =>
      m.sections.find((s) => s.id === "content")!.fields.map((f) => f.name),
    );
    for (const names of content) expect(names).toEqual(content[0]);
  });
});

/**
 * Every slot a manifest declares must be one the container actually supplies,
 * or the editor silently renders "Nothing to configure here yet" over a section
 * the offering genuinely needs — which for a class curriculum would make the
 * offering unsaveable, since ClassPlanSchema requires at least one item.
 */
describe("declared slots are all supplied", () => {
  const SUPPLIED = new Set(["faq", "curriculum", "roadmap", "collaborators"]);

  it("declares no slot the container cannot fill", () => {
    const declared = ALL.flatMap((m) =>
      m.sections.map((s) => s.slot).filter(Boolean),
    ) as string[];

    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((slot) => !SUPPLIED.has(slot))).toEqual([]);
  });

  it("keeps the class curriculum a slot, since the schema requires content", () => {
    const curriculum = CLASS_MANIFEST.sections.find(
      (s) => s.id === "curriculum",
    );
    expect(curriculum?.slot).toBe("curriculum");
  });

  it("gives the webinar a scheduledAt field, since publishing depends on it", () => {
    // The container blocks publish until this is set; without the field there
    // would be no way to ever satisfy it.
    expect(fieldNames(WEBINAR_MANIFEST)).toContain("scheduledAt");
  });
});

/**
 * One colour vocabulary. Three surfaces used to paint the same four states
 * three different ways, and none of them carried a legend.
 */
describe("slot status tokens", () => {
  it("defines a label, cell class and swatch for every state", async () => {
    const { SLOT_STATUS_TOKENS } = await import(
      "@/lib/scheduling/slot-status-tokens"
    );
    // The legend surfaces `hint` as a title, so an empty one is a silent gap.
    const incomplete = Object.entries(SLOT_STATUS_TOKENS)
      .filter(
        ([, t]) =>
          !t.label || !t.className || !t.swatchClassName || !t.hint,
      )
      .map(([key]) => key);

    expect(incomplete).toEqual([]);
  });

  it("legends reference only states that exist", async () => {
    const { SLOT_STATUS_TOKENS, BUYER_LEGEND_KEYS, CONSULTANT_LEGEND_KEYS } =
      await import("@/lib/scheduling/slot-status-tokens");
    const known = new Set(Object.keys(SLOT_STATUS_TOKENS));
    expect(BUYER_LEGEND_KEYS.filter((k) => !known.has(k))).toEqual([]);
    expect(CONSULTANT_LEGEND_KEYS.filter((k) => !known.has(k))).toEqual([]);
  });

  it("explains every state the consultant grid can render", async () => {
    const { SLOT_STATUS_TOKENS, CONSULTANT_LEGEND_KEYS } = await import(
      "@/lib/scheduling/slot-status-tokens"
    );
    // The allocate calendar can show all of them, so its legend must too — a
    // state with no legend entry is a colour nobody can interpret.
    expect([...CONSULTANT_LEGEND_KEYS].sort()).toEqual(
      Object.keys(SLOT_STATUS_TOKENS).sort(),
    );
  });

  // The cell-vs-legend colour-equality and border-conflict regression tests
  // for #1064 live in __tests__/schedule/slot-palette.test.ts, alongside a
  // source scan for the retired hardcoded classes.
});
