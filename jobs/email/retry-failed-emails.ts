/**
 * #474 — Transactional-email retry worker.
 *
 * Drains `FailedEmail` rows that lib/email.ts dead-lettered when a Resend
 * send failed (status PENDING on first persist, RETRY on any subsequent
 * scheduled attempt) and whose `nextRetryAt` is now or earlier. One tick:
 *
 *   1. Picks up to `MAX_BATCH` rows ordered by `nextRetryAt ASC NULLS FIRST`.
 *   2. RE-SENDS the stored message verbatim — `resend.emails.send` with the
 *      persisted html/text/subject/from/replyTo. NO dispatcher, NO re-render:
 *      the row IS the rendered message, so retry can't drift from the original.
 *   3. Records the outcome:
 *        - success → status=SENT, sentAt=now.
 *        - failure → status=RETRY with the next backoff slot, OR
 *          status=DEAD_LETTER if we just used the last attempt (5).
 *
 * Backoff schedule (mirrors the outbound-webhook worker)
 * ------------------------------------------------------
 *   attempt 1 → 1 minute
 *   attempt 2 → 5 minutes
 *   attempt 3 → 30 minutes
 *   attempt 4 → 2 hours
 *   attempt 5 → 8 hours (last)
 *   attempt 6 → DEAD_LETTER (operator-replayable)
 *
 * Why a polled table instead of a queue: same rationale as
 * lib/enterprise/outbound-webhooks/worker.ts — Netlify/Vercel ship no
 * first-class queue, and an indexed (status, nextRetryAt) walk handles the
 * transactional-email volume comfortably. The table IS the queue.
 *
 * Best-effort by contract: a re-send failure increments + reschedules; it
 * never throws into the cron wrapper.
 */

import prisma from "@/lib/prisma";
import type { FailedEmail, Prisma } from "@prisma/client";
import { Resend } from "resend";
import { DEFAULT_FROM_ADDRESS } from "@/lib/email";
import { withCronLock, CronLockHeldError } from "@/lib/cron/with-cron-lock";
import { recordSystemError } from "@/lib/enterprise/system-events";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "@/lib/observability/job-sentry";

const MAX_BATCH = 50;
const MAX_ATTEMPTS = 5;

/**
 * Backoff keyed by the attempt number AFTER incrementing. A row at
 * `attempts = 0` that we just re-sent once looks up `BACKOFF_MS[1]` for when
 * to try next. Identical schedule to the webhook worker by design.
 */
export const BACKOFF_MS: Record<number, number> = {
  1: 60_000, // 1 min
  2: 5 * 60_000, // 5 min
  3: 30 * 60_000, // 30 min
  4: 2 * 60 * 60_000, // 2 h
  5: 8 * 60 * 60_000, // 8 h
};

export interface EmailRetryRunResult {
  scanned: number;
  sent: number;
  retried: number;
  deadLettered: number;
  errors: string[];
}

/**
 * The slice of the client this worker touches. Typing only the two methods used
 * (rather than the whole PrismaClient) lets the unit test inject a faithful stub
 * without an `any` cast; the full client satisfies it structurally.
 */
export interface FailedEmailStore {
  failedEmail: {
    findMany(args: Prisma.FailedEmailFindManyArgs): Promise<FailedEmail[]>;
    update(args: Prisma.FailedEmailUpdateArgs): Promise<FailedEmail>;
  };
}

/**
 * Single-tick worker. fetchFn/now/resend are injectable so the backoff and
 * status semantics can be unit-tested without the network or a real clock.
 */
export async function runEmailRetryTick(params: {
  prisma: FailedEmailStore;
  /// Inject a Resend stub for testing; production builds one from the env key.
  resend?: Pick<Resend["emails"], "send">;
  /// Override the clock for deterministic tests.
  now?: () => number;
  /// Batch ceiling override; defaults to MAX_BATCH.
  maxBatch?: number;
}): Promise<EmailRetryRunResult> {
  const { prisma } = params;
  const now = params.now ?? (() => Date.now());
  const batchLimit = params.maxBatch ?? MAX_BATCH;

  const result: EmailRetryRunResult = {
    scanned: 0,
    sent: 0,
    retried: 0,
    deadLettered: 0,
    errors: [],
  };

  // Resolve the sender once. Without a key (and no injected stub) there's
  // nothing to retry against — bail cleanly so the cron stays green.
  const emails = params.resend ?? buildResendEmails();
  if (!emails) {
    result.errors.push("RESEND_API_KEY not configured; skipping email retry");
    return result;
  }

  const nowDate = new Date(now());
  const dueRows = await prisma.failedEmail.findMany({
    where: {
      OR: [
        { status: "PENDING" },
        { status: "RETRY", nextRetryAt: { lte: nowDate } },
      ],
    },
    orderBy: [{ nextRetryAt: { sort: "asc", nulls: "first" } }],
    take: batchLimit,
  });

  for (const row of dueRows) {
    result.scanned += 1;

    let sendError: string | undefined;
    try {
      // Verbatim re-send of the stored rendered message. No dispatcher, no
      // re-render: replay exactly what the original sender handed Resend.
      const result = await emails.send({
        from: row.fromAddress ?? DEFAULT_FROM_ADDRESS,
        to: row.recipient,
        subject: row.subject,
        html: row.htmlBody,
        text: row.textBody ?? undefined,
        replyTo: row.replyTo ?? undefined,
      });
      // Resend resolves (does not throw) on API-level errors — a non-null
      // `error` is still a failure, so it must not be mistaken for a success.
      if (result.error) {
        sendError = result.error.message || "Resend API error";
      }
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
    }

    if (!sendError) {
      await prisma.failedEmail.update({
        where: { id: row.id },
        data: {
          status: "SENT",
          attempts: row.attempts + 1,
          sentAt: nowDate,
          lastError: null,
        },
      });
      result.sent += 1;
      continue;
    }

    const attemptNumber = row.attempts + 1;
    const nextAttemptNumber = attemptNumber + 1;

    if (attemptNumber >= MAX_ATTEMPTS) {
      // DEAD_LETTER: retries exhausted, terminal but operator-replayable
      // (the rendered message is still on the row — see optional replay route).
      await prisma.failedEmail.update({
        where: { id: row.id },
        data: {
          status: "DEAD_LETTER",
          attempts: attemptNumber,
          lastError: sendError,
        },
      });
      result.deadLettered += 1;
    } else {
      const backoff = BACKOFF_MS[nextAttemptNumber] ?? BACKOFF_MS[MAX_ATTEMPTS];
      await prisma.failedEmail.update({
        where: { id: row.id },
        data: {
          status: "RETRY",
          attempts: attemptNumber,
          nextRetryAt: new Date(now() + backoff),
          lastError: sendError,
        },
      });
      result.retried += 1;
    }
  }

  return result;
}

// Resolve a Resend sender from the env key. Returns null when unset so the
// tick can bail cleanly instead of throwing on a missing key.
function buildResendEmails(): Pick<Resend["emails"], "send"> | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key).emails;
}

// #476 — no IN_FLIGHT soft lock on FailedEmail, so the cron lock is the only
// thing keeping two overlapping ticks from double-sending a row.
// Wave-3 (#1230): flipped from fail-open to FAIL-CLOSED. The original rationale
// ("a missing lock shouldn't block the sweep") predates #1179's ops-paging:
// today a held/unavailable lock now fails the tick loudly and pages, whereas
// fail-open silently allowed two replicas to send every failed email twice.
// Deferred retries resume next tick once Redis recovers — no message loss,
// just delay.
export async function retryFailedEmails(): Promise<EmailRetryRunResult> {
  return withCronLock("retry-failed-emails", { failMode: "closed" }, () =>
    runEmailRetryTick({ prisma }),
  );
}

if (require.main === module) {
  // tsx doesn't auto-load .env outside the Next.js runtime; without this
  // RESEND_API_KEY/DATABASE_URL are undefined. (Mirrors the webhook wrapper.)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv/config");
  runJob("retry-failed-emails", async () => {
    await abortIfMaintenance("retry-failed-emails");
    Sentry.logger.info("job:retry-failed-emails started");
    console.log("📧 Retrying dead-lettered transactional emails...");
    try {
      const result = await retryFailedEmails();
      console.log(JSON.stringify(result, null, 2));
      Sentry.logger.info("job:retry-failed-emails finished", {
        scanned: result.scanned,
        sent: result.sent,
        retried: result.retried,
        deadLettered: result.deadLettered,
        errors: result.errors.length,
      });
      if (result.errors.length > 0) process.exitCode = 1;
    } catch (err) {
      // A crashed retry sweep means transactional emails stay stuck — surface
      // it to the telemetry sink too. Everything generic (capture, job tag,
      // step annotation, exit code, lock-held skip) is runJob's. (#1066)
      if (!(err instanceof CronLockHeldError)) {
        await recordSystemError({
          category: "EMAIL",
          summary: "Transactional email retry job crashed",
          err,
        });
      }
      throw err;
    } finally {
      await prisma.$disconnect();
    }
  });
}
