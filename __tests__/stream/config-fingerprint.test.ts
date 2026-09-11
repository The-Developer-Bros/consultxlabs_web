/**
 * The drift check that decides whether an operator is told their webhook
 * subscription was just destroyed. Two false-positive sources bit the
 * 2026-09-01 rollout and both are pinned here.
 */
import { canonical, diffFingerprints } from "@/lib/stream/config-fingerprint";

describe("canonical", () => {
  it("ignores key order", () => {
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }));
  });

  it("ignores array order — Stream returns geofences reordered between reads", () => {
    const read1 = [
      { name: "canada", country_codes: ["CA"] },
      { name: "india", country_codes: ["IN"] },
      { name: "united_kingdom", country_codes: ["GB"] },
    ];
    const read2 = [
      { name: "united_kingdom", country_codes: ["GB"] },
      { name: "canada", country_codes: ["CA"] },
      { name: "india", country_codes: ["IN"] },
    ];
    expect(canonical(read1)).toBe(canonical(read2));
  });

  it("ignores updated_at — updateApp re-stamps it on an unrelated write", () => {
    const hook = {
      id: "44a1d716",
      webhook_url: "https://example.test/api/stream/webhooks",
      enabled: true,
      created_at: "2026-01-21T18:25:57.403Z",
    };
    expect(canonical([{ ...hook, updated_at: "2026-08-30T12:49:55.753Z" }])).toBe(
      canonical([{ ...hook, updated_at: "2026-09-01T10:27:31.680Z" }]),
    );
  });

  it("still catches a real change behind a re-stamp", () => {
    const before = [
      { id: "h", enabled: true, updated_at: "2026-08-30T12:49:55.753Z" },
    ];
    const after = [
      { id: "h", enabled: false, updated_at: "2026-09-01T10:27:31.680Z" },
    ];
    expect(canonical(before)).not.toBe(canonical(after));
  });

  it("still catches a lost array element behind a reorder", () => {
    const before = [{ name: "canada" }, { name: "india" }];
    const after = [{ name: "india" }];
    expect(canonical(before)).not.toBe(canonical(after));
  });

  it("normalizes nested arrays, not just the top level", () => {
    expect(canonical({ h: [{ types: ["b", "a"] }] })).toBe(
      canonical({ h: [{ types: ["a", "b"] }] }),
    );
  });

  it("keeps created_at — a change there means the object was replaced", () => {
    expect(canonical([{ created_at: "2026-01-21T18:25:57.403Z" }])).not.toBe(
      canonical([{ created_at: "2026-09-01T00:00:00.000Z" }]),
    );
  });
});

describe("diffFingerprints", () => {
  it("names only the fields that differ", () => {
    expect(
      diffFingerprints(
        { event_hooks: "a", geofences: "b" },
        { event_hooks: "a", geofences: "c" },
      ),
    ).toEqual(["geofences"]);
  });
});
