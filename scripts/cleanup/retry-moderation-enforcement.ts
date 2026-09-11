/**
 * Moderation enforcement retry sweep (#1270).
 *
 * The moderation action route runs its Stream write best-effort: the ban row,
 * the session revocation, the cancellations and the refunds all commit, and if
 * Stream happens to be down (or the circuit breaker is open) the harasser's
 * existing chat token keeps working for up to an hour. The failure was recorded
 * in `ModerationAction.sideEffects` and then nothing ever retried it, because
 * the route's 409 idempotency guard — which is what stops a double refund —
 * also blocks the only path that could have re-run the Stream step.
 *
 * This sweep drains exactly that queue. It reuses the durability shape of
 * `sweep-stuck-webhook-events`: select the rows whose recorded outcome says
 * "failed", re-drive the same code the live path runs, write the new outcome
 * back, and stamp a terminal marker once a row has aged or been attempted past
 * its budget so a permanently broken one stops churning. The `sideEffects` JSON
 * IS the outbox — there is no second table to keep in step with it.
 *
 * Re-driving is safe because every Stream step is idempotent (see
 * applyStreamEnforcement) and because a step is skipped outright once the state
 * that justified it is gone: a lifted ban is never re-revoked.
 */
import type { ModerationActionType } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import {
  applyStreamEnforcement,
  restoreStreamAccess,
  streamErrorPrefix,
  type ModerationReportRef,
  type SideEffectSummary,
} from "@/lib/moderation/side-effects";

export interface ModerationRetryResult {
  success: boolean;
  scanned: number;
  /** The Stream step landed on this attempt. */
  recovered: number;
  /** Still failing; will be attempted again next run. */
  stillFailing: number;
  /** Terminally capped — out of attempts or too old for the retry to mean anything. */
  gaveUp: number;
  /** No longer applicable: the ban was lifted, so re-revoking would be harmful. */
  skipped: number;
  errors: string[];
}

export interface ModerationRetryOptions {
  /** Attempts, counting the original one made by the action route. */
  maxAttempts?: number;
  /**
   * Past this age a retry stops being a repair. A ban whose Stream revocation
   * never landed in three days needs an operator, not a seventh attempt.
   */
  giveUpAfterHours?: number;
  limit?: number;
}

const RETRYABLE_ACTIONS: ModerationActionType[] = [
  "USER_BANNED",
  "USER_SUSPENDED",
  "CONTENT_REMOVED",
  "USER_REINSTATED",
];

type ActionRow = {
  id: string;
  actionType: ModerationActionType;
  createdAt: Date;
  sideEffects: unknown;
  report: {
    id: string;
    targetUserId: string;
    reviewId: string | null;
    streamMessageId: string | null;
    streamChannelCid: string | null;
  };
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function summaryOf(row: ActionRow): SideEffectSummary {
  return (row.sideEffects ?? {}) as SideEffectSummary;
}

function reportRefOf(row: ActionRow): ModerationReportRef {
  return {
    id: row.report.id,
    targetUserId: row.report.targetUserId,
    reviewId: row.report.reviewId,
    streamMessageId: row.report.streamMessageId,
    // #1270 review — the delete needs the channel too. Selecting only the id
    // meant the re-drive could not address the message it was retrying.
    streamChannelCid: row.report.streamChannelCid,
  };
}

async function writeSummary(
  actionId: string,
  summary: SideEffectSummary,
): Promise<void> {
  await prisma.moderationAction.update({
    where: { id: actionId },
    // NOT structuredClone (Sonar S7784) — see the note in
    // lib/moderation/side-effects.ts. Optional fields must be dropped, not
    // preserved as `undefined`, for Prisma's InputJsonValue.
    data: { sideEffects: JSON.parse(JSON.stringify(summary)) },
  });
}

/**
 * Is the account state that justified this Stream step still in force?
 *
 * A ban that has since been lifted must not be re-enforced — re-revoking a
 * reinstated user's tokens would kick them out of chat all over again, which is
 * the very defect the reinstatement was undoing. A suspension whose `banExpires`
 * has passed is over for the same reason, even though the column stays `true`
 * until the target next signs in and the auth plugin clears it lazily.
 */
async function stillApplicable(row: ActionRow): Promise<boolean> {
  if (row.actionType === "CONTENT_REMOVED") return true;
  if (row.actionType === "USER_REINSTATED") return true;

  const user = await prisma.user.findUnique({
    where: { id: row.report.targetUserId },
    select: { banned: true, banExpires: true },
  });
  if (!user?.banned) return false;
  return !(user.banExpires && user.banExpires.getTime() <= Date.now());
}

// #476 — every scheduled entry shares one mutual exclusion. Fail-closed: two
// concurrent sweeps could both read `attempts: 2` and burn the budget twice.
export async function retryModerationEnforcement(
  opts: ModerationRetryOptions = {},
): Promise<ModerationRetryResult> {
  return withCronLock(
    "retry-moderation-enforcement",
    { failMode: "closed" },
    () => retryModerationEnforcementUnlocked(opts),
  );
}

async function retryModerationEnforcementUnlocked(
  opts: ModerationRetryOptions = {},
): Promise<ModerationRetryResult> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const giveUpAfterHours = opts.giveUpAfterHours ?? 72;
  const limit = opts.limit ?? 100;
  const giveUpOlderThan = new Date(Date.now() - giveUpAfterHours * 3_600_000);

  // `stream: "failed"` is the queue. The terminal marker is a different value
  // ("gave_up"), so a capped row falls out of this selector by construction
  // rather than by a negated JSON filter that a null path would defeat.
  const rows = (await prisma.moderationAction.findMany({
    where: {
      actionType: { in: RETRYABLE_ACTIONS },
      sideEffects: { path: ["stream"], equals: "failed" },
    },
    select: {
      id: true,
      actionType: true,
      createdAt: true,
      sideEffects: true,
      report: {
        select: {
          id: true,
          targetUserId: true,
          reviewId: true,
          streamMessageId: true,
          streamChannelCid: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  })) as ActionRow[];

  const result: ModerationRetryResult = {
    success: true,
    scanned: rows.length,
    recovered: 0,
    stillFailing: 0,
    gaveUp: 0,
    skipped: 0,
    errors: [],
  };

  for (const row of rows) {
    await retryOne(row, { maxAttempts, giveUpOlderThan }, result);
  }

  // #1270 review — a sweep that left enforcement unlanded did not succeed.
  // `jobs/` reads this to decide the workflow's exit code.
  result.success = result.errors.length === 0 && result.gaveUp === 0;

  return result;
}

async function retryOne(
  row: ActionRow,
  budget: { maxAttempts: number; giveUpOlderThan: Date },
  result: ModerationRetryResult,
): Promise<void> {
  const summary = summaryOf(row);
  const attempts = summary.streamAttempts ?? 1;

  if (
    attempts >= budget.maxAttempts ||
    row.createdAt < budget.giveUpOlderThan
  ) {
    await cap(row, summary, result, "out of retry budget");
    return;
  }

  let applicable: boolean;
  try {
    applicable = await stillApplicable(row);
  } catch (error) {
    result.stillFailing++;
    result.errors.push(`${row.id}: ${errMsg(error)}`);
    return;
  }
  if (!applicable) {
    // Not a failure and not a success: the enforcement was reversed while the
    // Stream step was still owed, so there is nothing left to enforce.
    summary.stream = "skipped";
    summary.errors = appendNote(
      summary.errors,
      "stream: not retried — the ban was lifted before the retry ran",
    );
    await writeSummary(row.id, summary).catch(captureRetryError);
    result.skipped++;
    return;
  }

  try {
    if (row.actionType === "USER_REINSTATED") {
      await restoreStreamAccess(row.report.targetUserId);
    } else {
      await applyStreamEnforcement(row.actionType, reportRefOf(row));
    }
    summary.stream = "ok";
    summary.streamAttempts = attempts + 1;
    await writeSummary(row.id, summary);
    result.recovered++;
    console.log(`✅ Re-drove moderation enforcement for action ${row.id}`);
  } catch (error) {
    summary.stream = "failed";
    summary.streamAttempts = attempts + 1;
    summary.errors = appendNote(
      summary.errors,
      `${streamErrorPrefix(row.actionType)}: ${errMsg(error)} (attempt ${attempts + 1})`,
    );
    await writeSummary(row.id, summary).catch(captureRetryError);
    result.stillFailing++;
    result.errors.push(`${row.id}: ${errMsg(error)}`);
  }
}

async function cap(
  row: ActionRow,
  summary: SideEffectSummary,
  result: ModerationRetryResult,
  reason: string,
): Promise<void> {
  summary.stream = "gave_up";
  summary.errors = appendNote(
    summary.errors,
    `${streamErrorPrefix(row.actionType)}: gave up — ${reason}`,
  );
  await writeSummary(row.id, summary).catch(captureRetryError);
  result.gaveUp++;
  result.errors.push(`${row.id}: gave up — ${reason}`);
  // A capped row means an account is enforced in the database and unenforced on
  // Stream, indefinitely. That needs a human, so it pages.
  Sentry.captureMessage(
    `Moderation enforcement gave up for action ${row.id} (${row.actionType})`,
    { level: "error", tags: { subsystem: "moderation" } },
  );
}

// Keep the whole attempt history rather than overwriting: which attempt started
// failing, and how the message changed, is what tells an operator whether this
// is an outage or a permanently bad row.
function appendNote(errors: string[] | undefined, note: string): string[] {
  return [...(errors ?? []), note];
}

function captureRetryError(error: unknown): void {
  Sentry.captureException(
    error instanceof Error ? error : new Error(String(error)),
    { tags: { subsystem: "moderation" } },
  );
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
