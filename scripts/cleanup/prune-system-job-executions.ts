/**
 * SystemJobExecution Retention + Stranded-Run Reconciler — Core Logic
 *
 * `SystemJobExecution` is the cron trail: `lib/cron/with-cron-lock.ts` opens a
 * RUNNING row on every locked run and closes it COMPLETED or FAILED when the
 * body settles. Nothing has ever closed the rows it could not close itself, and
 * nothing has ever deleted an old one, so the table had two defects at once.
 *
 * Retention. The trail is engineering telemetry with no statutory window, and a
 * quarter of history is more than enough to answer "when did this job last
 * succeed" and to reconstruct an incident. Anything older is dead weight on a
 * table that gains a row per job per run, which at the current fleet size is
 * several thousand rows a day. Ninety days it is, well inside the 400-day
 * SystemEvent window because a job execution carries far less diagnostic value
 * than the error it produced.
 *
 * Stranded runs. A job whose process dies — an Actions runner evicted, an
 * out-of-memory kill, a `process.exit` inside a job body — never reaches
 * `recordJobFinish`, so its row stays RUNNING forever. Those rows make the
 * trail unreadable: "is this job running right now" cannot be answered when the
 * answer includes runs from six months ago. Every workflow in the fleet sets
 * `timeout-minutes` well under an hour and the longest lock TTL is 35 minutes,
 * so a row still RUNNING six hours later cannot be a live run. It is stamped
 * FAILED with an explicit reason rather than deleted, because "this job died
 * without reporting" is exactly the fact an operator needs to see.
 *
 * Both predicates are pure and exported so the windows can be tested without a
 * database. Schedule: 03:26 UTC daily, after prune-audit-logs at 03:15.
 */

import prisma from "../../lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";

const RETENTION_DAYS = 90;

/**
 * Six hours. The longest cron lock TTL is 35 minutes (LONG_JOB_TTL_MS) and
 * every workflow caps itself with `timeout-minutes`, so this is an order of
 * magnitude past any run that is still alive.
 */
const STRANDED_HOURS = 6;

/**
 * Rows deleted per statement. The trail gains a row per job per run — several
 * thousand a day at the current fleet size — so the first run after this ships
 * faces the whole pre-retention backlog at once. One unbounded `DELETE` over
 * that backlog is a single long-running statement holding row locks on a table
 * every cron run writes to; a bounded loop keeps each statement short.
 */
const DELETE_BATCH_SIZE = 5_000;

/** Rows created before this are past retention and get deleted. */
export function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/** Rows that started before this and are still RUNNING cannot be alive. */
export function strandedCutoff(now: Date): Date {
  return new Date(now.getTime() - STRANDED_HOURS * 60 * 60 * 1000);
}

/** The reason stamped on a run that never reported an outcome. */
export const STRANDED_ERROR = "stranded (no heartbeat)";

export interface SystemJobExecutionPruneResult {
  pruned: number;
  stranded: number;
  retentionCutoff: string;
  strandedCutoff: string;
}

// #476 — locked at the core so every entry (GitHub Actions / HTTP) shares one
// mutual exclusion; fail-open because both writes are idempotent.
export async function pruneSystemJobExecutions(): Promise<SystemJobExecutionPruneResult> {
  return withCronLock("prune-system-job-executions", { failMode: "open" }, () =>
    pruneSystemJobExecutionsUnlocked(),
  );
}

async function pruneSystemJobExecutionsUnlocked(): Promise<SystemJobExecutionPruneResult> {
  const now = new Date();
  const retention = retentionCutoff(now);
  const stranded = strandedCutoff(now);

  // Close the stranded rows FIRST. Doing it after the delete would leave a run
  // that is both stranded and past retention counted twice on the boundary.
  const closed = await prisma.systemJobExecution.updateMany({
    where: { status: "RUNNING", startedAt: { lt: stranded } },
    data: {
      status: "FAILED",
      endedAt: now,
      errorLog: STRANDED_ERROR,
    },
  });

  let pruned = 0;
  for (;;) {
    const doomed = await prisma.systemJobExecution.findMany({
      where: { startedAt: { lt: retention } },
      select: { id: true },
      take: DELETE_BATCH_SIZE,
    });
    if (doomed.length === 0) break;

    const deleted = await prisma.systemJobExecution.deleteMany({
      where: { id: { in: doomed.map((row) => row.id) } },
    });
    pruned += deleted.count;

    // A batch that selected rows but deleted none means a concurrent run took
    // them; without this the loop would re-select the same page forever.
    if (deleted.count === 0 || doomed.length < DELETE_BATCH_SIZE) break;
  }

  console.log(
    `[prune-system-job-executions] stranded=${closed.count} pruned=${pruned} ` +
      `retentionCutoff=${retention.toISOString()} strandedCutoff=${stranded.toISOString()}`,
  );

  return {
    pruned,
    stranded: closed.count,
    retentionCutoff: retention.toISOString(),
    strandedCutoff: stranded.toISOString(),
  };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
