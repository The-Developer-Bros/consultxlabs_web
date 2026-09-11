/**
 * The moderation stat cards read 0 permanently — shape drift that `tsc` could
 * not see, because the client type is hand-written rather than derived from
 * the route.
 *
 * The route wraps its counters in a `stats` envelope; the client returned the
 * whole envelope annotated as `ModerationStats`, so every field was
 * `undefined` and every card fell to its `?? 0`. Three of the four counter
 * names also differed between route and type, so even unwrapping would have
 * fixed only one card. And two counters measured the wrong thing entirely —
 * "Reviews to Check" was an unfiltered count of every review row ever written
 * rather than a queue, and "Resolved Today" counted the whole `?days=` window,
 * 7 by default.
 */

import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("moderation stats reach the cards", () => {
  const ROUTE = read("app/api/staff/moderation/stats/route.ts");
  const CLIENT = read("components/dashboard/shared/ModerationPage.tsx");
  const TYPES = read("types/moderation.ts");

  /** Field names declared on the shared ModerationStats interface. */
  const typeFields = (() => {
    const start = TYPES.indexOf("export interface ModerationStats {");
    const block = TYPES.slice(start, TYPES.indexOf("\n}", start));
    return Array.from(block.matchAll(/^\s+(\w+):\s*number/gm), (m) => m[1]);
  })();

  /** Field names the route puts inside its `stats` envelope. */
  const routeFields = (() => {
    const start = ROUTE.indexOf("stats: {");
    const block = ROUTE.slice(start, ROUTE.indexOf("},", start));
    return Array.from(block.matchAll(/^\s+(\w+),?$/gm), (m) => m[1]);
  })();

  it("the route emits exactly the fields the shared type declares", () => {
    expect(typeFields.length).toBeGreaterThan(0);
    expect(routeFields.slice().sort()).toEqual(typeFields.slice().sort());
  });

  it("every field the cards read is one the route emits", () => {
    const readFields = Array.from(
      CLIENT.matchAll(/stats\?\.(\w+)/g),
      (m) => m[1],
    );
    expect(readFields.length).toBeGreaterThan(0);
    const unknown = readFields.filter((f) => !routeFields.includes(f));
    expect(unknown).toEqual([]);
  });

  it("the client unwraps the stats envelope", () => {
    // Returning `response.json()` typed as ModerationStats is the original
    // bug: it typechecks and every field is undefined at runtime.
    expect(CLIENT).toContain("{ stats: ModerationStats }");
    expect(CLIENT).toContain("return body.stats;");
  });

  it('"Resolved Today" counts from midnight, not the ?days= window', () => {
    expect(ROUTE).toContain("startOfToday");
    expect(ROUTE).toContain("resolvedAt: { gte: startOfToday }");
  });

  it('"Reviews to Check" counts a queue, not every review ever written', () => {
    // ConsultantReview carries no status/flag column, so the only queue a
    // review can be in is a PENDING report against it.
    expect(ROUTE).not.toContain("consultantReview.count()");
    expect(ROUTE).toContain('status: "PENDING", type: "REVIEW"');
  });
});
