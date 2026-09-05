/**
 * @jest-environment node
 */

/**
 * #1169 — the drift guard behind "every scheduled job is locked".
 *
 * PR 6 made cron locking universal by walking the fleet once and fixing what
 * it found. That audit is worthless the moment someone adds workflow number 62
 * without a lock, so this test re-derives the same walk from source on every
 * run: `.github/workflows/*.yml` → the entrypoint each one executes → the
 * `withCronLock` call in that entrypoint or in the core it delegates to.
 *
 * It reads files as text rather than importing them. Job modules connect to
 * Prisma and Redis at import time, and a registry check must not need either.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/observability/job-sentry", () => ({
  flushJobSentry: jest.fn(),
  runJob: jest.fn(),
}));

import fs from "node:fs";
import path from "node:path";

import { FINANCIAL_JOB_NAMES } from "../../lib/maintenance-cron";
import { entrypointOf } from "../fixtures/workflow-introspection";

const ROOT = path.join(__dirname, "..", "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");

/**
 * Workflows that are legitimately not wrapped in `withCronLock`. Each entry
 * names the mechanism that replaces it — "no lock" is never an accepted reason.
 */
const LOCK_EXEMPT: Record<string, string> = {
  // Two bespoke Redis locks predate withCronLock and additionally guard the
  // HTTP approval path, which withCronLock's key shape does not reach. See
  // lib/payments/payouts/payout-service.ts.
  "process-payouts.yml": "lock:payout_processing in payout-service.ts",
  "create-payout-batch.yml": "lock:payout_batch_creation in payout-service.ts",
  // The dead-man switch itself. Locking it through Redis would make the
  // watchdog depend on the infrastructure it exists to report on, and the
  // check is read-only, so a double-run costs nothing.
  "cron-heartbeat.yml": "deliberately unlocked — read-only dead-man switch",
  // #1270 — a drift DETECTOR, not a job. It runs the operator script in
  // `--check` mode, which makes no Stream write and no database write; the
  // whole run is one `getAppSettings` read. Two concurrent reads cost one
  // extra API call, so a lock would buy nothing and would give a read-only
  // guard a hard dependency on Redis.
  "stream-webhook-drift.yml": "deliberately unlocked — read-only drift check",
};

interface Row {
  workflow: string;
  entrypoint: string | null;
  jobName: string;
  lockedIn: string | null;
  failMode: string | null;
}

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

function findLock(
  src: string | null,
): { jobName: string; failMode: string } | null {
  if (!src) return null;
  // No dotAll flag: the options group is `[^}]*`, a negated class that already
  // spans newlines, so the lock survives being formatted across lines.
  const m = src.match(/withCronLock\(\s*["'`]([^"'`]+)["'`]\s*,\s*\{([^}]*)\}/);
  if (!m) return null;
  const failMode = m[2].match(/failMode:\s*["']([^"']+)["']/);
  return { jobName: m[1], failMode: failMode ? failMode[1] : "unparsed" };
}

function buildRegistry(): Row[] {
  const rows: Row[] = [];

  for (const workflow of fs.readdirSync(WORKFLOW_DIR).sort()) {
    if (!/\.ya?ml$/.test(workflow)) continue;
    const src = read(path.join(WORKFLOW_DIR, workflow));
    if (!src || !/^\s*schedule:/m.test(src)) continue;

    const entrypoint = entrypointOf(src);
    const entryFile = entrypoint ? path.join(ROOT, entrypoint) : null;
    const entrySrc = entryFile ? read(entryFile) : null;

    let lock = findLock(entrySrc);
    let lockedIn = lock ? entrypoint : null;

    // Wrapper → core: jobs/** wrappers hold the GitHub Actions plumbing and
    // delegate to a scripts/** or lib/** core, which is where the lock usually
    // lives so every entry point (Actions, HTTP, local) inherits it.
    if (!lock && entrySrc && entryFile) {
      for (const imp of entrySrc.matchAll(
        /from\s+["'](@\/[^"']+|\.\.?\/[^"']+)["']/g,
      )) {
        const resolved = resolveImport(entryFile, imp[1]);
        if (!resolved) continue;
        const rel = path.relative(ROOT, resolved);
        if (!/^(scripts|lib)\//.test(rel) || rel.includes("with-cron-lock")) {
          continue;
        }
        const found = findLock(read(resolved));
        if (found) {
          lock = found;
          lockedIn = rel;
          break;
        }
      }
    }

    const guard = entrySrc?.match(/abortIfMaintenance\(\s*["'`]([^"'`]+)["'`]/);
    rows.push({
      workflow,
      entrypoint,
      jobName:
        guard?.[1] ??
        lock?.jobName ??
        path.basename(entrypoint ?? workflow, ".ts"),
      lockedIn,
      failMode: lock?.failMode ?? null,
    });
  }

  return rows;
}

const registry = buildRegistry();

describe("cron lock registry (#1169)", () => {
  it("finds the whole scheduled fleet", () => {
    // A floor, not an equality: new jobs are expected. This only catches the
    // parser silently matching nothing after a workflow-format change.
    expect(registry.length).toBeGreaterThanOrEqual(61);
  });

  it("resolves an entrypoint for every scheduled workflow", () => {
    const unresolved = registry
      .filter((r) => !r.entrypoint)
      .map((r) => r.workflow);
    expect(unresolved).toEqual([]);
  });

  it("locks every scheduled job, or names why it does not", () => {
    const unlocked = registry
      .filter((r) => !r.lockedIn && !(r.workflow in LOCK_EXEMPT))
      .map((r) => `${r.workflow} → ${r.entrypoint} (no withCronLock)`);

    // Wrap the core in withCronLock rather than adding to LOCK_EXEMPT: an
    // unlocked job double-runs whenever a schedule overlaps a manual dispatch.
    expect(unlocked).toEqual([]);
  });

  it("keeps every exemption pointing at a workflow that still exists", () => {
    const stale = Object.keys(LOCK_EXEMPT).filter(
      (wf) => !registry.some((r) => r.workflow === wf),
    );
    expect(stale).toEqual([]);
  });

  it("drops an exemption once the job grows a real lock", () => {
    const redundant = registry
      .filter((r) => r.workflow in LOCK_EXEMPT && r.lockedIn)
      .map((r) => r.workflow);
    expect(redundant).toEqual([]);
  });

  it("runs every financial job fail-closed", () => {
    // A fail-open money job keeps running while Redis is down, which is the
    // exact window in which two runners both believe they hold the lock.
    const wrong = registry
      .filter(
        (r) =>
          FINANCIAL_JOB_NAMES.has(r.jobName) &&
          !(r.workflow in LOCK_EXEMPT) &&
          r.failMode !== "closed",
      )
      .map((r) => `${r.jobName} is failMode:${r.failMode ?? "unlocked"}`);

    expect(wrong).toEqual([]);
  });

  it("parses a failMode for every lock it found", () => {
    const unparsed = registry
      .filter(
        (r) => r.lockedIn && r.failMode !== "open" && r.failMode !== "closed",
      )
      .map((r) => `${r.workflow} → ${r.failMode}`);
    expect(unparsed).toEqual([]);
  });

  it("schedules every financial job it declares", () => {
    // FINANCIAL_JOB_NAMES gates abortIfMaintenance. A name that matches no job
    // protects nothing, and is usually a rename that lost its guard.
    const orphaned = [...FINANCIAL_JOB_NAMES].filter(
      (name) => !registry.some((r) => r.jobName === name),
    );
    expect(orphaned).toEqual([]);
  });

  it("gates every refund front-door caller behind FINANCIAL_JOB_NAMES (#1506)", () => {
    // A refunding sweep that is not in the set runs straight through DEGRADED
    // maintenance, which is the exact bug #1506 fixed for the no-show and
    // expiry sweeps. Grep scripts/** for callers rather than trusting a
    // hand-maintained list, so a new refunding script fails this test instead
    // of shipping unguarded.
    const REFUND_FRONT_DOORS = [
      "refundBookingPayment(",
      "refundWholeEventPayments(",
      "refundRemovedAttendeeSeat(",
      "refundPaymentsForExpired(",
    ];
    const SCRIPTS_DIR = path.join(ROOT, "scripts");

    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith(".ts")) out.push(full);
      }
      return out;
    }

    const callers = walk(SCRIPTS_DIR).filter((file) => {
      const src = read(file);
      return !!src && REFUND_FRONT_DOORS.some((fn) => src.includes(fn));
    });

    expect(callers.length).toBeGreaterThan(0);

    const ungated = callers
      .map((file) => {
        const lock = findLock(read(file));
        return { file: path.relative(ROOT, file), jobName: lock?.jobName };
      })
      .filter((r) => !r.jobName || !FINANCIAL_JOB_NAMES.has(r.jobName))
      .map((r) => `${r.file} → withCronLock("${r.jobName ?? "none"}")`);

    expect(ungated).toEqual([]);
  });

  it("gives every scheduled workflow a queueing concurrency group", () => {
    // #1413 — a second, redundant guard alongside withCronLock: an overlap
    // should queue behind the in-flight run at the Actions layer too, not
    // just at the Redis layer. cancel-in-progress must stay false, since
    // killing a mid-flight money job is the one thing worse than a double run.
    const missing = registry
      .map((r) => r.workflow)
      .filter((workflow) => {
        const src = read(path.join(WORKFLOW_DIR, workflow));
        if (!src) return true;
        const hasGroup = /^concurrency:\s*\n\s*group:\s*\S+/m.test(src);
        const hasNoCancel = /cancel-in-progress:\s*false/.test(src);
        return !(hasGroup && hasNoCancel);
      });
    expect(missing).toEqual([]);
  });
});
