/**
 * #1119 was never a bug in the fail-open helper's default. It was a bug in
 * call-site WIRING: a route that had become ISR was still degrading, so a
 * transient pooler timeout became a 200 that Netlify wrote into the durable cache
 * and replayed to every visitor for the whole revalidate window.
 *
 * The helper's unit tests cannot catch that class — they pass whatever the routes
 * do. This one reads the route sources directly and pins the invariant that
 * actually matters: degrading and being cacheable are mutually exclusive.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const APP_DIR = path.join(process.cwd(), "app");

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...routeFiles(full));
    } else if (entry === "page.tsx" || entry === "route.ts") {
      out.push(full);
    }
  }
  return out;
}

const files = routeFiles(APP_DIR).map((file) => ({
  rel: path.relative(process.cwd(), file),
  src: readFileSync(file, "utf8"),
}));

// A `revalidate` export is what makes a render persistable: Next stores the HTML
// and Netlify's durable cache replays it. `dynamic = "force-dynamic"` is the only
// thing that guarantees a render reaches exactly one visitor.
const isCacheable = (src: string) =>
  /export\s+const\s+revalidate\s*=/.test(src) &&
  !/export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/.test(src);
const isForceDynamic = (src: string) =>
  /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/.test(src);
const degrades = (src: string) => /perRequest/.test(src);

// `degrades` above only sees degradation that goes through lib/data/fail-open.ts,
// because `perRequest` is the helper's opt-in flag. A hand-written
// `catch { return [] }` is the same hazard on a cacheable route and contains no
// such token — that blind spot is #1125, and two live examples were found in
// /explore/programs while reviewing #1123.
//
// The invariant pinned instead is narrower and sharper than "returns a
// placeholder", which is not reliably detectable from source: a catch that binds
// NOTHING cannot report what it swallowed, to Sentry or anywhere else. Binding
// the error is the floor. `catch (e) {` passes; `catch {` does not. `.catch(fn)`
// is untouched — that is a call, not a clause.
//
// Comments are matched between `catch` and `{` because `\s` alone does not, and
// `catch /* why */ {` is both legal and exactly what someone reaches for when
// explaining why a swallow is fine. A guard a comment can switch off is worse
// than no guard, because it still reads as coverage.
const hasBareCatch = (src: string) =>
  /(?:^|[^.\w])catch\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*\{/.test(src);

describe("#1119 — a cacheable route must never fail open", () => {
  it("finds the route files it is supposed to be guarding", () => {
    // Guards against the walk silently matching nothing and passing vacuously.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => isCacheable(f.src))).toBe(true);
    expect(files.some((f) => degrades(f.src))).toBe(true);
  });

  it("no route with a revalidate export opts into degrading", () => {
    const offenders = files
      .filter((f) => isCacheable(f.src) && degrades(f.src))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("every route that opts into degrading is force-dynamic or a Route Handler", () => {
    const offenders = files
      .filter(
        (f) =>
          degrades(f.src) &&
          !isForceDynamic(f.src) &&
          !f.rel.endsWith("route.ts"),
      )
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("the bare-catch detector matches the shape it claims to (#1125)", () => {
    // Anchored on fixtures rather than on real files on purpose. The obvious
    // anchor — "some route in the repo has a bare catch" — decays into a vacuous
    // pass the moment the sweep in #1125 removes the last one, and it would do
    // so silently, which is the exact failure mode this whole file exists for.
    expect(hasBareCatch("try { x() } catch { return [] }")).toBe(true);
    expect(hasBareCatch("try { x() } catch{return null}")).toBe(true);
    // A comment between the clause and its body must not hide it.
    expect(
      hasBareCatch("try { x() } catch /* transient only */ { return [] }"),
    ).toBe(true);
    expect(
      hasBareCatch("try { x() } catch\n  // safe, see #123\n{ return [] }"),
    ).toBe(true);
    expect(
      hasBareCatch("try { x() } catch (err) { report(err); return [] }"),
    ).toBe(false);
    // A `.catch(handler)` call is the sanctioned form and must not be flagged.
    expect(hasBareCatch("read().catch(emptyOnTransientDbError('x'))")).toBe(
      false,
    );
  });

  it("no cacheable route swallows an error it cannot report (#1125)", () => {
    const offenders = files
      .filter((f) => isCacheable(f.src) && hasBareCatch(f.src))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("the degraded consultant shell is deleted, not merely unreferenced", () => {
    // Rendered, not just mentioned — the fix's own comment cites the component by
    // name, and a comment is not a regression.
    const renders = files
      .filter((f) =>
        /<ConsultantUnavailable|from ".*ConsultantUnavailable"/.test(f.src),
      )
      .map((f) => f.rel);
    expect(renders).toEqual([]);
    expect(
      existsSync(
        path.join(
          APP_DIR,
          "explore/experts/[consultantId]/components/ConsultantUnavailable.tsx",
        ),
      ),
    ).toBe(false);
  });
});
