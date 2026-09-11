/**
 * Dead-man's switch for the scheduled fleet.
 *
 * The failure pager (`notify-ops-failure.sh`) only fires on runs that FAIL. It
 * cannot detect a run that never started, and there are two ways that happens:
 * GitHub disables scheduled workflows after 60 days of repository inactivity,
 * and the `schedule` trigger is explicitly best-effort with no SLA. Either way
 * the whole money fleet can go quiet without a single red run.
 *
 * This job asks the Actions API when each workflow last started and fails when
 * one has been silent for implausibly long.
 *
 * The threshold deliberately is NOT the declared cadence. Measured on this repo
 * (2026-07-28): an every-minute schedule actually delivers about one tick every
 * 102 minutes, and an every-15-minutes schedule about one every 100 minutes.
 * Alerting on the declared interval would page constantly and train everyone to
 * ignore it — the same trap the ledger reconciler fell into. So:
 *
 *   sub-daily jobs   -> alert after max(interval x 12, 6h)
 *   daily and slower -> alert after interval x 3
 *
 * The 6-hour floor is set from data, not taste: the worst observed real gap on
 * a sub-hourly job was 2.4h (cleanup-abandoned-payments), so a 3h floor left
 * only 1.25x headroom and would have flapped. Six hours of total silence from a
 * job declared every 15 minutes is unambiguous. Since this check runs daily,
 * the cost of the wider window is at most one day of detection latency, which
 * is the right trade for an alert that people still trust. Throttling severity
 * is a separate concern, tracked in #866 and ADR 22.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Redis } from "@upstash/redis";

const ROOT = path.join(__dirname, "..", "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

/** Smallest gap between consecutive firings of a 5-field cron, in ms. */
function shortestIntervalMs(expr: string): number | null {
  const [min, hour, dom, mon, dow] = expr.split(/\s+/);
  if (!min || !hour) return null;

  const step = (field: string, unitMs: number, span: number): number | null => {
    if (field === "*") return unitMs;
    const m = field.match(/^(?:\*|\d+-\d+)\/(\d+)$/);
    if (m) return Number(m[1]) * unitMs;
    if (/^\d+$/.test(field)) return span * unitMs; // fires once per span
    return null;
  };

  const minuteStep = step(min, MIN_MS, 60);
  if (minuteStep === null) return null;
  // A minute field that fires more than once an hour dominates the cadence,
  // regardless of the hour restriction: the shortest gap between two firings is
  // the minute step either way. (`13-59/30 * * * *` fires at :13 and :43 — a
  // 30-minute gap — and restricting the hour would not shorten it.)
  if (minuteStep < 60 * MIN_MS) return minuteStep;
  // Otherwise the hour field decides.
  const hourStep = step(hour, HOUR_MS, 24);
  if (hourStep === null) return null;
  if (hourStep < 24 * HOUR_MS) return hourStep;
  // Daily or slower: weekly / monthly restrictions widen it further.
  if (dow !== "*") return 7 * 24 * HOUR_MS;
  if (dom !== "*" || mon !== "*") return 31 * 24 * HOUR_MS;
  return 24 * HOUR_MS;
}

function toleranceMs(intervalMs: number): number {
  return intervalMs < 24 * HOUR_MS
    ? Math.max(intervalMs * 12, 6 * HOUR_MS)
    : intervalMs * 3;
}

function human(ms: number): string {
  if (ms < HOUR_MS) return `${Math.round(ms / MIN_MS)}m`;
  if (ms < 24 * HOUR_MS) return `${(ms / HOUR_MS).toFixed(1)}h`;
  return `${(ms / (24 * HOUR_MS)).toFixed(1)}d`;
}

const repo = process.env.GITHUB_REPOSITORY;
if (!repo) {
  console.log("check-cron-heartbeat: GITHUB_REPOSITORY unset — skipping");
  process.exit(0);
}

// `now` comes from the runner clock; a heartbeat is inherently wall-clock work.
const now = Date.now();
const stale: string[] = [];
const ok: string[] = [];
const skipped: string[] = [];

for (const file of fs
  .readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith(".yml"))) {
  const body = fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8");
  const crons = Array.from(body.matchAll(/-\s*cron:\s*["']([^"']+)["']/g)).map(
    (m) => m[1].trim(),
  );
  if (crons.length === 0) continue;

  const intervals = crons
    .map(shortestIntervalMs)
    .filter((v): v is number => v !== null);
  if (intervals.length === 0) {
    skipped.push(`${file} (unparsed cron: ${crons.join(", ")})`);
    continue;
  }
  const interval = Math.min(...intervals);
  const tolerance = toleranceMs(interval);

  let lastRun: string | undefined;
  try {
    const out = execFileSync(
      "gh",
      [
        "api",
        `repos/${repo}/actions/workflows/${file}/runs`,
        "-X",
        "GET",
        "-f",
        "event=schedule",
        "-f",
        "per_page=1",
        "--jq",
        ".workflow_runs[0].created_at // empty",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    lastRun = out || undefined;
  } catch {
    skipped.push(`${file} (Actions API unavailable)`);
    continue;
  }

  if (!lastRun) {
    // Never run on a schedule. Newly added workflows land here legitimately.
    skipped.push(`${file} (no scheduled run on record yet)`);
    continue;
  }

  const age = now - Date.parse(lastRun);
  const headroom = (tolerance / Math.max(age, 1)).toFixed(1);
  const line = `${file.replace(/\.ya?ml$/, "")}: last scheduled run ${human(age)} ago (declared every ${human(interval)}, tolerance ${human(tolerance)}, headroom ${headroom}x)`;
  if (age > tolerance) stale.push(line);
  else ok.push(line);
}

/**
 * #1169/#866 — second dead-man leg. This check watches the fleet through the
 * Actions API, but nothing watches the check: if GitHub disables schedules
 * repo-wide, this workflow goes silent along with everything it guards. So the
 * fleet reports itself out-of-band too: every locked job run refreshes
 * `cron:heartbeat:last` (see lib/cron/with-cron-lock.ts), this daily run
 * refreshes it as well, and /api/health flags the key going >6h stale — a
 * surface an external uptime pinger can watch with no GitHub dependency.
 * Fail-open: the Redis write must never decide this check's verdict.
 */
async function writeFleetHeartbeat(): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.warn(
      "check-cron-heartbeat: UPSTASH_REDIS env vars not set — skipping heartbeat write",
    );
    return;
  }
  try {
    const redis = new Redis({ url, token });
    await redis.set("cron:heartbeat:last", new Date().toISOString());
  } catch (err) {
    console.warn("check-cron-heartbeat: heartbeat write failed:", err);
  }
}

void writeFleetHeartbeat().finally(() => {
  // Always print the full picture: this job's log is the only place the fleet's
  // real cadence is visible, and headroom shrinking over time is the early
  // warning that throttling is getting worse.
  for (const s of skipped) console.log(`  skipped ${s}`);
  for (const s of ok.sort((a, b) => a.localeCompare(b)))
    console.log(`  ok ${s}`);

  if (stale.length > 0) {
    console.error(
      `\ncheck-cron-heartbeat: FAILED — ${stale.length} workflow(s) have stopped firing:\n`,
    );
    for (const s of stale) console.error(`  - ${s}`);
    console.error(
      "\nA scheduled workflow that never starts produces no failed run, so nothing else " +
        "in this repo would have told you. Check whether GitHub disabled the schedules " +
        "(60 days of repo inactivity does that automatically) before assuming a code fault.",
    );
    // exitCode, not exit(): the heartbeat write above already settled, but a
    // hard exit here would also skip any queued stdio flushes.
    process.exitCode = 1;
    return;
  }

  console.log(
    `check-cron-heartbeat: ok (${ok.length} scheduled workflows firing within tolerance, ${skipped.length} skipped)`,
  );
});
