/**
 * CI guard for `.github/workflows/` — two failure modes that are invisible at
 * runtime and therefore have to be caught at build time.
 *
 * 1. UNDECLARED SECRETS. A `${{ secrets.NAME }}` that does not exist does not
 *    error; it interpolates an empty string and the job reports success while
 *    running without a credential. That is how #677 PM-1 came back after being
 *    fixed in application code — the workflows were rewired to source Razorpay
 *    creds from `secrets.RAZORPAY_KEY_SECRET`, which has never existed. Every
 *    referenced name must appear in the manifest at
 *    docs/enterprise/50-operations/07-required-secrets.md, which is where the
 *    "what breaks without it" consequence is written down and reviewed.
 *
 * 2. POOL-BUDGET OVERRUNS ON SHARED START MINUTES. Simultaneous cron starts
 *    stampede the Supavisor pool — the contention behind #932. This guard used
 *    to fail ANY recurring shared start-minute, but minute-uniqueness is only
 *    a proxy for the real invariant (concurrent pool footprint) and it scales
 *    badly: every new job needs a fresh minute on an ever more crowded clock.
 *    So the guard now models cost instead of uniqueness. A workflow may declare
 *    its estimated DB-active runtime anywhere in the file with
 *    `# cron-runtime-minutes: N` (default: DEFAULT_RUNTIME_MINUTES below), and
 *    a start-minute shared by recurring jobs fails only when the summed
 *    declared runtimes exceed POOL_BUDGET_MINUTES. Once-a-day overlaps stay
 *    tolerated: they collide once and cost nothing.
 *
 * Pure static analysis: no network, no database, safe to run anywhere.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");
const MANIFEST = path.join(
  ROOT,
  "docs",
  "enterprise",
  "50-operations",
  "07-required-secrets.md",
);

const errors: string[] = [];

/** Strip `#` comments so a secret name mentioned in prose isn't read as a reference. */
function stripComments(yaml: string): string {
  return yaml
    .split("\n")
    .map((line) => {
      const hash = line.indexOf("#");
      if (hash === -1) return line;
      // Only treat `#` as a comment when it starts the token — avoids eating
      // `#709`-style issue refs that appear inside quoted strings.
      const before = line.slice(0, hash);
      const quotes = (before.match(/"/g) ?? []).length;
      return quotes % 2 === 1 ? line : before;
    })
    .join("\n");
}

const files = fs
  .readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

// ---------------------------------------------------------------- secrets ---

// Manifest rows look like `| \`SECRET_NAME\` | consumers | consequence |`, and a
// single cell may list several comma-separated names.
const manifest = fs.readFileSync(MANIFEST, "utf8");
const declared = new Set<string>();
for (const row of manifest.split("\n")) {
  if (!row.trimStart().startsWith("|")) continue;
  const firstCell = row.split("|")[1] ?? "";
  for (const m of firstCell.matchAll(/`([A-Z0-9_]+)`/g)) declared.add(m[1]);
}
if (declared.size === 0) {
  errors.push(
    `manifest parse failure: no secret names found in ${path.relative(ROOT, MANIFEST)}`,
  );
}

const referencedBy = new Map<string, string[]>();
for (const file of files) {
  const body = stripComments(
    fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8"),
  );
  for (const m of body.matchAll(/secrets\.([A-Z0-9_]+)/g)) {
    const list = referencedBy.get(m[1]) ?? [];
    if (!list.includes(file)) list.push(file);
    referencedBy.set(m[1], list);
  }
}

for (const [secret, workflows] of Array.from(referencedBy).sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  // GITHUB_TOKEN is injected by Actions itself and is never a repo secret.
  if (secret === "GITHUB_TOKEN") continue;
  if (!declared.has(secret)) {
    errors.push(
      `undeclared secret \`${secret}\` referenced by ${workflows.join(", ")} — ` +
        `add a row to ${path.relative(ROOT, MANIFEST)} stating what breaks without it`,
    );
  }
}

// -------------------------------------------------------------- schedules ---

/**
 * Expand the minute+hour fields of a 5-field cron into the concrete (hour,
 * minute) start times it fires at. Only the forms this fleet actually uses are
 * supported: `*`, a literal, a step expression, and `a-b/n`.
 */
function expandField(field: string, max: number): number[] {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    let lo = 0;
    let hi = max;
    if (range !== "*") {
      if (range.includes("-")) {
        const [a, b] = range.split("-").map(Number);
        lo = a;
        hi = b;
      } else {
        lo = hi = Number(range);
      }
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return Array.from(out);
}

type Start = {
  workflow: string;
  expr: string;
  firingsPerDay: number;
  runtimeMinutes: number;
};

/**
 * Estimated DB-active runtime per workflow, in minutes. Declared anywhere in
 * the workflow file as a comment line `# cron-runtime-minutes: N`; absent means
 * the default below. Deliberately a comment, not YAML: the estimate is metadata
 * for THIS guard, not for the Actions scheduler, and keeping it beside the cron
 * line keeps schedule and cost visible in one place.
 */
const DEFAULT_RUNTIME_MINUTES = 2;

/**
 * Per-start-minute budget for the summed declared DB-active runtime of
 * co-starting recurring jobs. Derived from the pool guidance in lib/prisma.ts:
 * pg.Pool opens up to 10 clients PER function instance (PG_POOL_MAX clamps it
 * to 1–2 in serverless deploy envs), and Supavisor's transaction pooler fronts
 * a small server-side pool — the #932 saturation surfaced as 5–9.6s connects
 * once concurrent clients piled up. Ten minutes of declared concurrent work per
 * start-minute keeps the expected overlap inside what the pooler absorbs
 * without queue-stall cascades. It is a policy dial, not physics: raising it is
 * a deliberate act and should come with pooler metrics attached.
 */
const POOL_BUDGET_MINUTES = 10;

// Raw text, NOT stripComments() output — the annotation IS a comment. A file
// may declare once; conflicting repeats are ambiguous and rejected.
const declaredRuntime = new Map<string, number>();
for (const file of files) {
  const raw = fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8");
  const matches = Array.from(raw.matchAll(/#\s*cron-runtime-minutes:\s*(\S+)/g));
  if (matches.length === 0) continue;
  const valid = new Set<number>();
  for (const m of matches) {
    const value = Number(m[1]);
    if (Number.isInteger(value) && value > 0) valid.add(value);
    else
      errors.push(
        `${file}: invalid \`# cron-runtime-minutes: ${m[1]}\` — must be a positive whole number of minutes`,
      );
  }
  if (valid.size > 1) {
    errors.push(
      `${file}: conflicting \`# cron-runtime-minutes\` declarations ` +
        `(${Array.from(valid).join(", ")}) — keep exactly one`,
    );
    continue;
  }
  const [value] = valid;
  if (value !== undefined) declaredRuntime.set(file, value);
}

// A single job that declares more than the whole per-minute budget can never
// be scheduled safely — no amount of staggering fits it alongside anything
// else. Fail it on its own declaration rather than waiting for a co-starter.
for (const [file, minutes] of declaredRuntime) {
  if (minutes > POOL_BUDGET_MINUTES) {
    errors.push(
      `${file}: declared cron-runtime-minutes: ${minutes} exceeds ` +
        `POOL_BUDGET_MINUTES=${POOL_BUDGET_MINUTES} on its own — split the job ` +
        `into cheaper passes or raise the budget deliberately (with pooler metrics)`,
    );
  }
}

const startsAt = new Map<string, Start[]>(); // scoped "HH:MM" -> workflows

for (const file of files) {
  const body = stripComments(
    fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8"),
  );
  for (const m of body.matchAll(/-\s*cron:\s*["']([^"']+)["']/g)) {
    const expr = m[1].trim();
    const [min, hour, dom, , dow] = expr.split(/\s+/);
    // Day-scoped jobs (monthly, weekly) only collide with an every-hour job on
    // the days they actually run, which the hour+minute key already captures.
    if (!min || !hour) continue;
    const hours = expandField(hour, 23);
    const minutes = expandField(min, 59);
    const firingsPerDay = hours.length * minutes.length;
    for (const h of hours) {
      for (const mm of minutes) {
        // A job restricted to one weekday or one day-of-month is keyed with
        // that restriction so it isn't reported against every day's fleet.
        const scope =
          dom !== "*" ? `dom${dom}` : dow !== "*" ? `dow${dow}` : "daily";
        const key = `${scope} ${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
        const list = startsAt.get(key) ?? [];
        list.push({
          workflow: file,
          expr,
          firingsPerDay,
          runtimeMinutes: declaredRuntime.get(file) ?? DEFAULT_RUNTIME_MINUTES,
        });
        startsAt.set(key, list);
      }
    }
  }
}

// `* * * * *` fires on every minute by design and would collide with everything;
// exclude it from collision reporting but keep it visible in the summary.
const EVERY_MINUTE = new Set(
  files.filter((f) =>
    /-\s*cron:\s*["']\*\s+\*\s+\*\s+\*\s+\*["']/.test(
      fs.readFileSync(path.join(WORKFLOW_DIR, f), "utf8"),
    ),
  ),
);

// What actually matters is the summed pool footprint of jobs that *recurring-ly*
// start together. Two daily jobs that happen to share 02:35 collide once a day
// and cost nothing; two hourly jobs sharing :17 start together 24 times a day,
// every day. The old rule failed ANY such recurring share (minute-uniqueness),
// which treats a 2-minute sweep and a 9-minute reconciliation as identical and
// leaves the clock too full to schedule into. Now each shared start-minute is
// costed: the co-starters' declared runtimes are summed and compared against
// POOL_BUDGET_MINUTES. Once-a-day shares stay tolerated regardless of cost.
const SUB_DAILY = 1;
const coStarts = new Map<
  string,
  { slot: string; recurring: boolean; totalMinutes: number }
>();
for (const [slot, list] of Array.from(startsAt).sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  const contenders = list.filter((s) => !EVERY_MINUTE.has(s.workflow));
  // One entry per workflow even if several of its cron lines land on this slot.
  const perWorkflow = new Map<string, Start>();
  for (const c of contenders) {
    if (!perWorkflow.has(c.workflow)) perWorkflow.set(c.workflow, c);
  }
  if (perWorkflow.size < 2) continue;
  const pair = Array.from(perWorkflow.keys())
    .sort((a, b) => a.localeCompare(b))
    .map((w) => w.replace(/\.ya?ml$/, ""))
    .join(" + ");
  const recurring = Array.from(perWorkflow.values()).every(
    (s) => s.firingsPerDay > SUB_DAILY,
  );
  const totalMinutes = Array.from(perWorkflow.values()).reduce(
    (sum, s) => sum + s.runtimeMinutes,
    0,
  );
  // Keep the first slot seen for a set, let any recurring sighting win; the
  // summed cost is a function of the contender set, so repeats agree.
  const prior = coStarts.get(pair);
  coStarts.set(pair, {
    slot: prior?.slot ?? slot,
    recurring: (prior?.recurring ?? false) || recurring,
    totalMinutes: prior?.totalMinutes ?? totalMinutes,
  });
}

const notes: string[] = [];
for (const [pair, { slot, recurring, totalMinutes }] of coStarts) {
  if (!recurring) {
    notes.push(`  once-a-day start overlap at ${slot} — ${pair} (tolerated)`);
  } else if (totalMinutes > POOL_BUDGET_MINUTES) {
    errors.push(
      `pool-budget overrun at ${slot} — ${pair}: recurring co-starters declare ` +
        `${totalMinutes}m of combined DB-active runtime against a ` +
        `POOL_BUDGET_MINUTES=${POOL_BUDGET_MINUTES} budget (the #932 pool ` +
        `stampede). Stagger one of them, trim its declared ` +
        `\`# cron-runtime-minutes\`, or split its work.`,
    );
  } else {
    notes.push(
      `  shared recurring start at ${slot} — ${pair} ` +
        `(${totalMinutes}m ≤ ${POOL_BUDGET_MINUTES}m pool budget)`,
    );
  }
}

// ------------------------------------------------------------------ report ---

if (errors.length > 0) {
  console.error("check-workflow-hygiene: FAILED\n");
  for (const e of errors) console.error(`  - ${e}`);
  console.error(
    `\n${errors.length} problem(s) across ${files.length} workflow files.`,
  );
  process.exit(1);
}

if (notes.length > 0) {
  console.log(`check-workflow-hygiene: ${notes.length} tolerated overlap(s)`);
  for (const n of notes) console.log(n);
}
console.log(
  `check-workflow-hygiene: ok (${files.length} workflows, ` +
    `${referencedBy.size} distinct secrets, ` +
    `${declaredRuntime.size} declared runtime(s), ` +
    `pool budget ${POOL_BUDGET_MINUTES}m per start-minute respected)`,
);
