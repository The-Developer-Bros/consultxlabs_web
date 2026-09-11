import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import {
  assertNotInMaintenance,
  MaintenanceActiveError,
} from "@/lib/maintenance-cron";

/**
 * The one result→status mapping the whole cohort shares. Failure is tested
 * FIRST on purpose: the previous per-route ternaries asked "is anything
 * flagged?" before "did the run succeed?", so a run that both failed and found
 * a flagged row answered 207 — a 2xx, which reads as healthy to anything
 * watching the status. That is the same masking PM-34 removed from the refund
 * cascade.
 *
 * @param needsAttention A route-specific counter that means "succeeded, but an
 *   operator has to look" — a discrepancy, a double booking, a dispute that was
 *   already paid.
 */
export function statusFor(
  result: { success?: boolean },
  needsAttention = false,
): number {
  if (result.success === false) return 500;
  return needsAttention ? 207 : 200;
}

/** Ceiling on an explicit `?limit=`; above this it is clamped, not rejected. */
const LIMIT_CAP = 500;

/**
 * Thrown by {@link parseLimitParam} for a `?limit=` that is present but not a
 * positive integer, so `cleanupRoute` can answer 400 instead of the caller
 * silently falling through to an unbounded run — the failure mode a malformed
 * ticker request would otherwise hit.
 */
export class InvalidLimitError extends Error {
  constructor() {
    super("INVALID_LIMIT");
    this.name = "InvalidLimitError";
  }
}

/**
 * Optional `?limit=` cap shared by the routes the Netlify ticker drives every
 * five minutes (#1356, ADR 27 — docs/enterprise/70-design-decisions/27-state-as-outbox-and-scheduled-ticker.md).
 * A five-minute tick has to fit inside the ticker's per-target timeout, unlike
 * the nightly GitHub Actions run, which can afford an unbounded batch — so the
 * ticker sends `?limit=50` and every other caller (Actions, manual `curl`)
 * omits it and keeps today's unbounded behaviour. A present-but-invalid value
 * (empty, non-numeric, zero, negative, or fractional) throws
 * {@link InvalidLimitError} rather than being treated as absent; a value above
 * the cap is clamped to it.
 */
export function parseLimitParam(req: NextRequest): number | undefined {
  const raw = req.nextUrl.searchParams.get("limit");
  // #1459 — only a missing key is absent. A truthiness test also swallowed
  // `?limit=`, which is a caller that meant to bound the sweep and sent
  // nothing: it would have got the unbounded batch back, the exact silent
  // fall-through this parser exists to make visible.
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidLimitError();
  }
  return Math.min(n, LIMIT_CAP);
}

/**
 * Constant-time bearer comparison. Digesting first keeps both operands the
 * same fixed length, so neither the secret's length nor its matching prefix is
 * observable through response timing.
 */
function bearerMatches(authHeader: string | null, cronSecret: string): boolean {
  if (!authHeader) return false;
  const sha = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(sha(authHeader), sha(`Bearer ${cronSecret}`));
}

/**
 * Every job under `app/api/cleanup/*` needs the same HTTP twin: a
 * CRON_SECRET bearer check, a maintenance-phase guard, structured start/finish
 * logging, and a three-way error mapping (lock held → 409, maintenance active
 * → its own status, anything else → captured + 500). Before this factory that
 * ~75-line shape was hand-copied into 40+ route files, which is what SonarCloud
 * flagged as duplication — one job's guard bug would only ever get fixed in
 * the file someone happened to be looking at. Centralizing it means the guard
 * has exactly one place to be correct, and a route only differs by the one
 * thing that is actually route-specific: what it runs and how it maps the
 * result to a status code.
 */
export function cleanupRoute<T extends object>(opts: {
  /** Job name — feeds `assertNotInMaintenance`, the Sentry logger key, and the tag. */
  job: string;
  run: (req: NextRequest) => Promise<T>;
  /** What to log on finish; defaults to the whole result. */
  summarize?: (result: T) => Record<string, unknown>;
  /** Defaults to {@link statusFor} with no needs-attention flag. */
  status?: (result: T) => number;
  failureMessage?: string;
  /** Extra `message` field on the 401 body, for routes that carry one. */
  unauthorizedMessage?: string;
}): {
  GET: (req: NextRequest) => Promise<NextResponse>;
  POST: (req: NextRequest) => Promise<NextResponse>;
} {
  const { job, run, summarize, status, failureMessage, unauthorizedMessage } =
    opts;

  async function handle(req: NextRequest): Promise<NextResponse> {
    try {
      const authHeader = req.headers.get("authorization");
      const cronSecret =
        process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

      if (!cronSecret || !bearerMatches(authHeader, cronSecret)) {
        console.warn(`Unauthorized ${job} attempt`);
        return NextResponse.json(
          unauthorizedMessage
            ? { error: "Unauthorized", message: unauthorizedMessage }
            : { error: "Unauthorized" },
          { status: 401 },
        );
      }
      // The cron core is shared with the jobs/** entrypoint, which exits on
      // maintenance; this HTTP twin cannot exit, so it answers 503 instead.
      await assertNotInMaintenance(job);

      console.log(`Starting ${job} via API...`);
      Sentry.logger.info(`cron:${job} started`);

      const result = await run(req);
      const summary: Record<string, unknown> = summarize
        ? summarize(result)
        : (result as Record<string, unknown>);

      console.log(`${job} completed:`, summary);
      Sentry.logger.info(`cron:${job} finished`, summary);

      const responseStatus = status
        ? status(result)
        : statusFor(result as { success?: boolean });
      return NextResponse.json(result, { status: responseStatus });
    } catch (error) {
      // #476 — concurrent invocation (schedule overlap / manual re-run)
      // skips with a 409 instead of double-running.
      if (error instanceof CronLockHeldError) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      if (error instanceof InvalidLimitError) {
        return NextResponse.json({ error: "INVALID_LIMIT" }, { status: 400 });
      }
      if (error instanceof MaintenanceActiveError) {
        return NextResponse.json(
          { error: error.message, phase: error.phase },
          { status: error.httpStatus },
        );
      }
      // The exception text stays in Sentry and the server log. It used to be
      // echoed to the caller as `details`, which on these 36 endpoints means
      // Prisma query fragments, table and column names, gateway payloads and
      // payout identifiers — an internal leak the `app/api/**` contract
      // forbids, and one the cron caller has no use for anyway.
      Sentry.captureException(error, { tags: { subsystem: "cron", job } });
      console.error(`Error in ${job}:`, error);
      return NextResponse.json(
        { error: failureMessage ?? `Failed to run ${job}` },
        { status: 500 },
      );
    }
  }

  return { GET: handle, POST: handle };
}
