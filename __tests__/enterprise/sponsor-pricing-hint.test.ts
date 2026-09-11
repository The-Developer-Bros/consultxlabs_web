/**
 * Wave-9 (#1230) — org-context pricing hint helpers. Pure logic, no mocks.
 */

import {
  applySponsorPricingHintToManifest,
  resolveSponsorPricingHint,
} from "@/components/offerings/editor/sponsor-pricing-hint";
import { CLASS_MANIFEST } from "@/components/offerings/editor/manifests";

describe("resolveSponsorPricingHint", () => {
  it("returns null for no memberships", () => {
    expect(resolveSponsorPricingHint(undefined)).toBeNull();
    expect(resolveSponsorPricingHint(null)).toBeNull();
    expect(resolveSponsorPricingHint([])).toBeNull();
  });

  it("returns null when the only membership cannot sponsor (pure HOST)", () => {
    expect(
      resolveSponsorPricingHint([
        { status: "ACTIVE", canSponsor: false, organizationName: "HostCo" },
      ]),
    ).toBeNull();
  });

  it("returns null when the canSponsor membership is not ACTIVE", () => {
    expect(
      resolveSponsorPricingHint([
        { status: "SUSPENDED", canSponsor: true, organizationName: "Acme" },
      ]),
    ).toBeNull();
  });

  it("names the sponsoring org in the caption", () => {
    const hint = resolveSponsorPricingHint([
      { status: "ACTIVE", canSponsor: true, organizationName: "Acme College" },
    ]);
    expect(hint).toContain("Acme College");
    expect(hint).toMatch(/program/i);
  });

  it("falls back to a generic caption without an org name", () => {
    expect(resolveSponsorPricingHint([{ status: "ACTIVE", canSponsor: true }])).toMatch(
      /organisation's members/,
    );
  });

  it("skips non-sponsoring memberships and honours the first qualifying one", () => {
    const hint = resolveSponsorPricingHint([
      { status: "ACTIVE", canSponsor: false, organizationName: "HostCo" },
      { status: "ACTIVE", canSponsor: true, organizationName: "SponsorU" },
    ]);
    expect(hint).toContain("SponsorU");
  });
});

describe("applySponsorPricingHintToManifest", () => {
  it("stamps the hint on the price field and nothing else", () => {
    const hinted = applySponsorPricingHintToManifest(CLASS_MANIFEST, "HINT");
    const before = CLASS_MANIFEST.sections.flatMap((s) =>
      s.fields.filter((f) => f.kind === "price"),
    );
    const after = hinted.sections.flatMap((s) =>
      s.fields.filter((f) => f.kind === "price"),
    );
    expect(after).toHaveLength(before.length);
    expect(after.length).toBeGreaterThan(0);
    for (const field of after) {
      expect(field.description).toBe("HINT");
    }
    // Non-price fields untouched.
    const others = hinted.sections.flatMap((s) =>
      s.fields.filter((f) => f.kind !== "price"),
    );
    const othersBefore = CLASS_MANIFEST.sections.flatMap((s) =>
      s.fields.filter((f) => f.kind !== "price"),
    );
    expect(others).toEqual(othersBefore);
    // Original manifest not mutated.
    for (const field of before) {
      expect(field.description).not.toBe("HINT");
    }
  });
});
