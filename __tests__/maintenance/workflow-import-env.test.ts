/**
 * @jest-environment node
 */

/**
 * #1270 — the guard behind "a scheduled job can actually be imported".
 *
 * Five workflows in this fleet had never completed a single run, and nothing in
 * the repository said so. Their entrypoints reached `lib/supabase.ts`, which
 * opens with `import "server-only"` — a marker package whose main entry does
 * nothing but `throw`. Next resolves it to an empty module under the
 * `react-server` export condition; every other resolver, including the bare
 * `npx tsx jobs/...` process a workflow runs, gets the throw. The job therefore
 * died during module evaluation, before a line of its own code ran.
 *
 * The consequence was not cosmetic. Recordings past their org's retention
 * window were never tombstoned and the Supabase objects behind them were never
 * deleted, which is a DPDP erasure gap; permanent-storage transfers never ran,
 * so STREAM_ONLY recordings simply lapsed when Stream's fourteen-day URL
 * expired; and soft-deleted documents were never purged from storage.
 *
 * Three invariants are checked, all by re-deriving the import graph from source
 * on every run rather than trusting a list someone maintained once:
 *
 *   1. No scheduled entrypoint may reach a module that cannot be evaluated
 *      outside Next's `react-server` resolution, whether because it carries the
 *      `server-only` marker or because it uses an API that only exists there.
 *   2. A job on the known-unrunnable register must still be broken, so the
 *      register cannot outlive the defect it describes.
 *   3. A scheduled entrypoint that reaches the Supabase client module must be
 *      given the environment that module throws without, because a missing
 *      `NEXT_PUBLIC_SUPABASE_ANON_KEY` fails in exactly the same invisible way.
 *
 * Files are read as text, never imported: job modules connect to Prisma and
 * Redis at import time and a static guard must not need either.
 */

import fs from "node:fs";
import path from "node:path";
import { entrypointOf } from "../fixtures/workflow-introspection";

const ROOT = path.join(__dirname, "..", "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");

/** The client module every Supabase-touching job resolves to. */
const SUPABASE_CORE = "lib/supabase-storage-core.ts";

/**
 * Environment `lib/supabase-storage-core.ts` throws at module scope without.
 * The anon key is on this list even for jobs that only ever use the admin
 * client: the module builds the public client first and never reaches the
 * admin one.
 */
const SUPABASE_REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
];

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Resolve a `@/` or relative TS import to a file on disk. */
function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith("."))
    base = path.resolve(path.dirname(fromFile), spec);
  else return null;

  for (const suffix of [".ts", ".tsx", "/index.ts"]) {
    if (fs.existsSync(base + suffix)) return base + suffix;
  }
  return fs.existsSync(base) && fs.statSync(base).isFile() ? base : null;
}

/** Every first-party module an entrypoint pulls in, transitively. */
function importGraph(entryFile: string): string[] {
  const seen = new Set<string>();
  const stack = [entryFile];
  while (stack.length > 0) {
    const file = stack.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const src = read(file);
    if (!src) continue;
    for (const m of src.matchAll(/from\s+["'](@\/[^"']+|\.\.?\/[^"']+)["']/g)) {
      const resolved = resolveImport(file, m[1]);
      if (resolved) stack.push(resolved);
    }
  }
  return Array.from(seen).map((f) => path.relative(ROOT, f));
}

interface Row {
  workflow: string;
  src: string;
  entrypoint: string;
  graph: string[];
}

function buildRows(): Row[] {
  const rows: Row[] = [];
  for (const workflow of fs.readdirSync(WORKFLOW_DIR).sort()) {
    if (!/\.ya?ml$/.test(workflow)) continue;
    const src = read(path.join(WORKFLOW_DIR, workflow));
    if (!src || !/^\s*schedule:/m.test(src)) continue;
    const entrypoint = entrypointOf(src);
    if (!entrypoint) continue; // covered by the cron-lock registry test
    const entryFile = path.join(ROOT, entrypoint);
    if (!fs.existsSync(entryFile)) continue;
    rows.push({ workflow, src, entrypoint, graph: importGraph(entryFile) });
  }
  return rows;
}

const rows = buildRows();

/**
 * Modules whose module-scope code needs an API that only exists under Next's
 * `react-server` resolution, and which therefore throw in a bare Node process.
 *
 * The `server-only` marker is detected from source, so a new module carrying it
 * is caught without anyone updating a list. The rest have to be named, because
 * the dependency is on a runtime export rather than on an import that announces
 * itself.
 */
const EXTRA_UNLOADABLE: Record<string, string> = {
  // #1275 — `lib/auth-server.ts` was here. It called React's `cache()` at
  // module scope, and react@18.3.1 (the version package.json pins) has no such
  // export, so a bare Node process got a TypeError before any job's own code
  // ran. The memo is built on first call now and falls back to an unmemoized
  // reader when `cache` is absent, so the module loads anywhere.
  //
  // Kept as an empty registry rather than deleted: the mechanism it catches —
  // a module that imports fine but throws on a runtime export — does not
  // announce itself in an import graph, so the next one has to be named here
  // too.
};

/**
 * Jobs that still reach an unloadable module and therefore still cannot run.
 *
 * This is a defect register, not a permission slip. An entry means the job is
 * known dead at import and the fix belongs to whoever owns that subsystem — the
 * point is that it is now written down and asserted, rather than being a red
 * workflow nobody is watching. Remove the entry when the job is fixed; the test
 * below fails if a listed job has quietly started working, so this list cannot
 * outlive the problem it describes.
 */
const KNOWN_UNRUNNABLE: Record<string, string> = {
  // #1275 — EMPTY, and that is the point.
  //
  // Eight workflows lived here. All eight reached `lib/auth-server.ts`, which
  // called React's `cache()` at module scope; `react@18.3.1` has no `cache`
  // export, so every one of them threw during module evaluation before a line
  // of its own code ran. Seven were the payments and payouts reconciliation
  // layer; the eighth was `sweep-stuck-webhook-events`, the durability backstop
  // the Stream webhook route explicitly delegates to. None had ever completed
  // a run.
  //
  // The fix was ten lines: build the memo on first call rather than at import,
  // and fall back to the unmemoized reader when `cache` is absent — which in a
  // one-shot cron process is the correct behaviour, not a degraded one.
  //
  // Leave this empty. An entry here is a job that cannot run, and every one
  // should be a bug with an issue rather than a line in a registry.
};

const unloadableModules = new Set([
  ...rows
    .flatMap((r) => r.graph)
    .filter((rel) =>
      /^import\s+["']server-only["']/m.test(read(path.join(ROOT, rel)) ?? ""),
    ),
  ...Object.keys(EXTRA_UNLOADABLE),
]);

/** The unloadable modules a given workflow's entrypoint pulls in. */
function unloadableReachedBy(row: Row): string[] {
  return row.graph.filter((rel) => unloadableModules.has(rel));
}

describe("scheduled workflows can import their own entrypoint (#1270)", () => {
  it("walks a non-trivial slice of the fleet", () => {
    // A floor, not an equality. This only catches the parser silently matching
    // nothing after a workflow-format change.
    expect(rows.length).toBeGreaterThanOrEqual(55);
  });

  it("never reaches a module that cannot load in a bare Node process", () => {
    // Move the dependency into a leaf module without the marker — as
    // `lib/supabase-storage-core.ts` is — rather than adding to the register
    // below. There is no runtime symptom to find later: the process throws
    // before its first log line, and the only trace is a red workflow nobody is
    // watching.
    const offenders = rows
      .filter((r) => !(r.workflow in KNOWN_UNRUNNABLE))
      .filter((r) => unloadableReachedBy(r).length > 0)
      .map(
        (r) =>
          `${r.workflow} → ${r.entrypoint} reaches ${unloadableReachedBy(r).join(", ")}`,
      );

    expect(offenders).toEqual([]);
  });

  it("drops a job from the register once it can actually load", () => {
    const fixed = Object.keys(KNOWN_UNRUNNABLE).filter((workflow) => {
      const row = rows.find((r) => r.workflow === workflow);
      return !row || unloadableReachedBy(row).length === 0;
    });

    expect(fixed).toEqual([]);
  });

  it("gives every Supabase-touching job the env that module throws without", () => {
    const missing: string[] = [];
    for (const row of rows) {
      if (!row.graph.includes(SUPABASE_CORE)) continue;
      for (const name of SUPABASE_REQUIRED_ENV) {
        if (!row.src.includes(name)) {
          missing.push(`${row.workflow} is missing ${name}`);
        }
      }
    }

    // An Actions expression referencing a secret that is not in the step env
    // interpolates nothing and the module throws at import — the same silent
    // shape the secrets manifest exists to prevent, one layer earlier.
    expect(missing).toEqual([]);
  });
});
