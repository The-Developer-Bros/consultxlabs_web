/**
 * Interval-Lock Test Helpers
 *
 * Shared primitives for the interval-atom scenarios (categories 10 and 11).
 * These sit alongside test-helpers.ts rather than inside it: test-helpers.ts
 * models ONE 30-minute atom per booking, while everything here is about
 * multi-atom intervals — overlap, ordering, rollback and TTL re-arm (#1170).
 *
 * Everything runs against the in-memory Redis mock (USE_MOCK_REDIS=true), so
 * no server, database or network is involved.
 */

import {
  lockSlotInterval,
  unlockSlotInterval,
  slotAtomStarts,
  type ApprovalLock,
} from "../../../../utils/appointmentlock.js";
import { SlotLockError } from "../../../../utils/errors/SlotLockError.js";
import redisClient from "../../../../lib/redis.js";
import {
  generateMarkdownReport,
  saveJsonReport,
  saveMarkdownReport,
} from "./test-helpers.js";
import type { BookingResult, SummaryReport, TestReport } from "./types";

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// Deterministic UTC intervals
// ============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

// One base day per process, floored to UTC midnight. Local-time fixtures drift
// with the runner's timezone and can straddle midnight between two calls; the
// atom grid is epoch-floored, so a UTC base keeps "10:00" on the grid anywhere.
const BASE_DAY_MS = Math.floor((Date.now() + 7 * DAY_MS) / DAY_MS) * DAY_MS;

export interface TestInterval {
  start: Date;
  end: Date;
  label: string;
}

function minutesOfClock(hhmm: string): number {
  const [hours, minutes] = hhmm.split(":");
  const total = Number(hours) * 60 + Number(minutes);
  if (!Number.isFinite(total)) {
    throw new TypeError(`interval-helpers: malformed clock time "${hhmm}"`);
  }
  return total;
}

function clockOfMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Build an interval from wall-clock strings, e.g. utcInterval("10:00", "12:00"). */
export function utcInterval(startHHMM: string, endHHMM: string): TestInterval {
  return utcIntervalFromMinutes(
    minutesOfClock(startHHMM),
    minutesOfClock(endHHMM),
  );
}

/** Build an interval from minute offsets into the base day. */
export function utcIntervalFromMinutes(
  startMinutes: number,
  endMinutes: number,
): TestInterval {
  return {
    start: new Date(BASE_DAY_MS + startMinutes * 60_000),
    end: new Date(BASE_DAY_MS + endMinutes * 60_000),
    label: `${clockOfMinutes(startMinutes)}-${clockOfMinutes(endMinutes)}`,
  };
}

// ============================================================================
// Atom math — the assertions read the same grid the lock layer keys on
// ============================================================================

/** The 30-minute atom starts an interval covers, as ISO strings. */
export function atomIsos(interval: TestInterval): string[] {
  return slotAtomStarts(interval.start, interval.end).map((atom) =>
    atom.toISOString(),
  );
}

// Mirrors the production key format on purpose: a test-side copy pins the
// namespace, so silently re-keying the locks fails these scenarios (#1169 §1).
export function atomKeys(
  consultantProfileId: string,
  interval: TestInterval,
): string[] {
  return atomIsos(interval).map(
    (iso) => `slot-booking:${consultantProfileId}:${iso}`,
  );
}

/** Atoms both intervals cover — non-empty exactly when they must contend. */
export function sharedAtoms(a: TestInterval, b: TestInterval): string[] {
  const other = new Set(atomIsos(b));
  return atomIsos(a).filter((iso) => other.has(iso));
}

// The client union (real Upstash vs MockRedis) only needs these two reads here.
const lockStore = redisClient as {
  exists(...keys: string[]): Promise<number>;
  pttl(key: string): Promise<number>;
};

export async function atomKeyExists(key: string): Promise<boolean> {
  return (await lockStore.exists(key)) === 1;
}

/** Remaining TTL in ms, or a negative Redis sentinel when unset/absent. */
export async function atomKeyTtlMs(key: string): Promise<number> {
  return await lockStore.pttl(key);
}

// ============================================================================
// Concurrency primitives
// ============================================================================

export interface Barrier {
  arriveAndWait(): Promise<void>;
}

/**
 * Countdown latch. A winner that releases as soon as it acquires lets a
 * retrying loser take the same atoms, which turns "exactly one wins" into a
 * coin flip; holding until every participant has settled makes it a fact.
 *
 * The wait is bounded: a participant that never arrives would otherwise hang
 * the scenario until the CI job's own timeout, which kills the run and saves no
 * report at all. Failing loudly is worth more than the extra timer.
 */
export function createBarrier(
  participants: number,
  timeoutMs = 30000,
): Barrier {
  let remaining = participants;
  let open: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });

  return {
    async arriveAndWait() {
      remaining -= 1;
      if (remaining <= 0) open?.();

      let timer: ReturnType<typeof setTimeout> | undefined;
      const abandoned = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `createBarrier: ${remaining} participant(s) never arrived within ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
      });

      try {
        await Promise.race([gate, abandoned]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface IntervalAttempt {
  userId: string;
  consultantProfileId: string;
  interval: TestInterval;
  ttlMs?: number;
  holdMs?: number;
  barrier?: Barrier;
}

/**
 * Acquire an interval lock and report the outcome in the harness's vocabulary:
 * 201 acquired, 409 genuine contention (SlotLockError), anything else 500.
 * `duration` measures acquisition only, not the hold.
 */
export async function attemptIntervalLock(
  attempt: IntervalAttempt,
): Promise<BookingResult> {
  const {
    userId,
    consultantProfileId,
    interval,
    ttlMs = 15000,
    holdMs = 0,
    barrier,
  } = attempt;

  const startedAt = Date.now();
  let locks: ApprovalLock[] | null = null;
  let outcome: BookingResult;

  try {
    locks = await lockSlotInterval(
      consultantProfileId,
      interval.start,
      interval.end,
      ttlMs,
    );
    outcome = {
      userId,
      status: 201,
      duration: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      data: { interval: interval.label, atoms: locks.map((lock) => lock.key) },
    };
  } catch (error) {
    outcome = {
      userId,
      status: error instanceof SlotLockError ? 409 : 500,
      duration: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      data: { interval: interval.label },
    };
  }

  if (barrier) await barrier.arriveAndWait();
  else if (holdMs > 0) await sleep(holdMs);

  if (locks) await unlockSlotInterval(locks);
  return outcome;
}

// ============================================================================
// Atom-granular booking registry (the validation layer the lock protects)
// ============================================================================

// Key format: "consultantProfileId:atomIso" → userId that booked it.
const bookedAtoms = new Map<string, string>();

export function resetIntervalRegistry(): void {
  bookedAtoms.clear();
}

/**
 * One booking attempt: lock the interval, check every atom it covers, write,
 * release. This is the shape production's direct writers have — the lock is
 * what makes check-then-write atomic, so an instant-keyed lock would let two
 * overlapping intervals both pass the check.
 */
export async function attemptIntervalBooking(
  // No barrier or hold: this one releases as soon as its write lands, which is
  // what makes the load scenarios drain instead of serialising on a held lock.
  attempt: Omit<IntervalAttempt, "barrier" | "holdMs"> & { writeMs?: number },
): Promise<BookingResult> {
  const {
    userId,
    consultantProfileId,
    interval,
    ttlMs = 15000,
    writeMs = 100,
  } = attempt;

  const startedAt = Date.now();
  let locks: ApprovalLock[] | null = null;

  try {
    locks = await lockSlotInterval(
      consultantProfileId,
      interval.start,
      interval.end,
      ttlMs,
    );

    const isos = atomIsos(interval);
    const taken = isos.find((iso) =>
      bookedAtoms.has(`${consultantProfileId}:${iso}`),
    );

    if (taken) {
      return {
        userId,
        status: 409,
        duration: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
        error: `Slot is already booked (atom ${taken})`,
        data: { interval: interval.label },
      };
    }

    await sleep(writeMs);
    isos.forEach((iso) =>
      bookedAtoms.set(`${consultantProfileId}:${iso}`, userId),
    );

    return {
      userId,
      status: 201,
      duration: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      data: { interval: interval.label, atoms: isos },
    };
  } catch (error) {
    return {
      userId,
      status: error instanceof SlotLockError ? 409 : 500,
      duration: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      data: { interval: interval.label },
    };
  } finally {
    if (locks) await unlockSlotInterval(locks);
  }
}

// ============================================================================
// Assertions inside the harness's pass/fail contract
// ============================================================================

/**
 * Express a structural claim as a result row so it flows through
 * generateTestReport untouched: a holding claim counts as a success, a broken
 * one lands in `errors` and fails the expectations.
 */
export function assertionResult(
  name: string,
  passed: boolean,
  detail: string,
): BookingResult {
  return {
    userId: `assert:${name}`,
    status: passed ? 201 : 500,
    duration: 0,
    timestamp: new Date().toISOString(),
    data: { detail },
    ...(passed ? {} : { error: `Assertion failed: ${detail}` }),
  };
}

export function logAssertions(results: BookingResult[]): void {
  const assertions = results.filter((result) =>
    result.userId.startsWith("assert:"),
  );
  if (assertions.length === 0) return;

  console.log("\n🔍 ASSERTIONS:\n");
  assertions.forEach((result) => {
    const detail = (result.data as { detail?: string } | undefined)?.detail;
    console.log(
      `   ${result.status === 201 ? "✅" : "❌"} ${result.userId.slice("assert:".length)} — ${detail ?? ""}`,
    );
  });
}

// ============================================================================
// Report saving (same artifacts as the sibling categories, one call)
// ============================================================================

export async function saveScenarioReports(
  report: TestReport,
  fileStem: string,
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  await saveJsonReport(report, `${report.category}/${fileStem}-${timestamp}.json`);

  const summaryReport: SummaryReport = {
    totalTests: 1,
    passedTests: report.passed ? 1 : 0,
    failedTests: report.passed ? 0 : 1,
    totalDuration: report.duration,
    categories: [
      {
        category: report.category,
        totalTests: 1,
        passedTests: report.passed ? 1 : 0,
        failedTests: report.passed ? 0 : 1,
        duration: report.duration,
        tests: [report],
      },
    ],
    timestamp: report.timestamp,
    mode: "sequential",
  };

  await saveMarkdownReport(
    generateMarkdownReport(summaryReport),
    `${fileStem}-${timestamp}.md`,
  );
}
