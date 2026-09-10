/**
 * #777 §B (locked decision: "edit safe fields, lock money config once in use").
 *
 * Pure predicates over whether a program/contract's MONEY config is locked. The
 * rule:
 *   - money config is editable while NOTHING is riding on it (no assignments,
 *     bookings, or overage events) — fixing a typo on a brand-new program is safe;
 *   - it locks read-only the moment it's in use, because a retroactive money edit
 *     would rewrite bookings already settled at the old terms (#779's hazard).
 * Safe identity fields (program name; contract auto-renew) stay editable always.
 *
 * #779 — the lock is now persistent: `Program.configLockedAt` is stamped in the
 * tx that creates the FIRST assignment (see program-helpers.ts) and is the
 * authoritative signal — locked is locked, and stays locked even after the
 * triggering rows are gone. The derived count check below is kept as a
 * belt-and-braces fallback (a pre-stamp legacy row, or counts > 0 with the
 * column somehow null still reads locked). pendingConfig / "applies-next-cycle"
 * was removed by design: changing money terms = archive this program + create a
 * new one (mirrors RateCard bump / contract supersession).
 */
import prisma from "@/lib/prisma";
import type { ContractStatus } from "@prisma/client";

/** Program money fields that lock once the program is in use. */
export const LOCKED_PROGRAM_FIELDS = [
  "type",
  "coveredPlanTypes",
  "ratePerSeatPaise",
  "coveredEngagementsPerCycle",
  "creditBudgetPerCycle",
  "overageBehavior",
  "overageSurchargeBps",
  "priceCapPerEngagementPaise",
  "maxOveragePerCyclePaise",
] as const;

/** Contract money/term fields that lock once the contract is in use. */
export const LOCKED_CONTRACT_FIELDS = [
  "billingAccountId",
  "effectiveFrom",
  "effectiveTo",
  "paymentTermsDays",
  "rateCardId",
] as const;

export interface ProgramLockSignals {
  assignmentCount: number;
  bookingCount: number;
  overageEventCount: number;
}

/** A program's money config is locked once anything rides on it. */
export function isProgramMoneyConfigLocked(s: ProgramLockSignals): boolean {
  return (
    s.assignmentCount > 0 || s.bookingCount > 0 || s.overageEventCount > 0
  );
}

export interface ContractLockSignals {
  status: ContractStatus;
  invoiceCount: number;
  liveAssignmentCount: number;
}

/**
 * A contract's terms lock once it leaves DRAFT (signed = committed terms) or
 * once any invoice is issued / any program under it has live assignments.
 */
export function isContractTermsLocked(s: ContractLockSignals): boolean {
  return (
    s.status !== "DRAFT" || s.invoiceCount > 0 || s.liveAssignmentCount > 0
  );
}

/**
 * Resolve the lock state for one program. #779 — `configLockedAt` is the
 * authoritative signal (non-null ⇒ locked); the bounded count queries stay as a
 * belt-and-braces fallback so counts > 0 still lock even if the column is null.
 *
 * CR #1234 wave-3 — pass a transaction client to read the caller's snapshot.
 * The pre-transaction friendly check uses the global client; callers that
 * WRITE money fields must re-check inside their tx, or a concurrent
 * first-assignment (which stamps `configLockedAt`) can land between check
 * and write and let terms change under a just-created allocation (#779).
 */
export async function getProgramLockState(
  programId: string,
  client: Pick<
    typeof prisma,
    "program" | "programAssignment" | "bookingUtilization" | "overageEvent"
  > = prisma,
): Promise<{ locked: boolean; signals: ProgramLockSignals }> {
  const [program, assignmentCount, bookingCount, overageEventCount] =
    await Promise.all([
      client.program.findUnique({
        where: { id: programId },
        select: { configLockedAt: true },
      }),
      client.programAssignment.count({ where: { programId } }),
      client.bookingUtilization.count({
        where: { programAssignment: { programId } },
      }),
      client.overageEvent.count({
        where: { programAssignment: { programId } },
      }),
    ]);
  const signals = { assignmentCount, bookingCount, overageEventCount };
  const locked =
    program?.configLockedAt != null || isProgramMoneyConfigLocked(signals);
  return { locked, signals };
}

/** Resolve the in-use signals for one contract. Same tx-client note as above. */
export async function getContractLockState(
  contractId: string,
  status: ContractStatus,
  client: Pick<typeof prisma, "organizationInvoice" | "programAssignment"> = prisma,
): Promise<{ locked: boolean; signals: ContractLockSignals }> {
  const [invoiceCount, liveAssignmentCount] = await Promise.all([
    client.organizationInvoice.count({ where: { contractId } }),
    client.programAssignment.count({
      where: { program: { contractId }, periodEnd: { gte: new Date() } },
    }),
  ]);
  const signals = { status, invoiceCount, liveAssignmentCount };
  return { locked: isContractTermsLocked(signals), signals };
}
