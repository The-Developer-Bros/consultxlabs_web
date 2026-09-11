/**
 * Test fixture: produce the full object graph the deferred Round-3
 * booking tests need (Appointment → Payment → OrganizationEarnings →
 * ledger entries) without rebuilding the entire booking UI flow.
 *
 * Why this is a TEST-ONLY fixture (not added to prisma/seed.ts)
 * ------------------------------------------------------------
 * Production booking flow is exercised by the live B2C path
 * (`POST /api/checkout/...` → Razorpay → webhook → settlement). This
 * fixture exists for Round-3 enterprise tests that need a
 * deterministic earnings row to assert against — tests for TDS
 * derivation, MSME deadline alerts, payout cascade refunds, etc.
 * Adding it to seed.ts would generate phantom earnings rows in dev
 * environments that don't have the corresponding booking surface.
 *
 * The fixture intentionally mirrors `createEarningsFromPayment` at
 * lib/payments/payouts/earnings-service.ts — if that helper's
 * invariants change, this fixture must be updated in lockstep. The
 * test files that use it should assert against the SAME columns the
 * production code path writes.
 *
 * Usage:
 *
 *   const { appointment, payment, earnings } =
 *     await createBookingWithEarnings({
 *       consultantUserId, consulteeUserId, organizationId,
 *       totalPaise: 5_000_00,
 *     });
 *   // ... assertions on earnings.netToOrgPaise, etc.
 *
 * Cleanup is the caller's responsibility — `prisma.appointment.delete`
 * cascades to the rest. Most tests run inside an `afterEach` wipe.
 */

import type { PrismaClient } from "@prisma/client";

export interface FixtureInput {
  prisma: PrismaClient;
  consultantUserId: string;
  consulteeUserId: string;
  /// HOST org that owns the rate-card + receives the earnings split.
  organizationId: string;
  totalPaise: number;
  /// Optional rate-card override; if omitted, falls back to the
  /// platform's default split (80/20). Useful when the test asserts
  /// per-org bps math.
  rateCardId?: string;
}

export interface FixtureResult {
  appointmentId: string;
  paymentId: string;
  earningsId: string | null;
}

/**
 * NOTE: The full implementation requires importing
 * `createEarningsFromPayment` and a real Appointment + SlotOfAppointment
 * graph. Production booking creates these via the
 * `SlotAllocationService` — recreating that here would couple the
 * fixture to internal scheduling APIs that drift independently of the
 * earnings flow.
 *
 * The recommended path (tracked in #674 follow-up) is to extract the
 * minimal "earnings-only" code path into a helper that takes a
 * pre-existing Appointment + Payment id and writes only the
 * OrganizationEarnings + ledger rows. This fixture is the placeholder
 * for that extraction.
 *
 * Until then, tests that need this should seed via Supabase MCP
 * directly (see `docs/enterprise/50-operations/03-runbooks.md` "Running cron jobs
 * locally" → "Seeding test data" section) and call
 * `createEarningsFromPayment` themselves.
 */
export async function createBookingWithEarnings(
  input: FixtureInput,
): Promise<FixtureResult> {
  // Implementation lands in a follow-up — see top-of-file note. The
  // signature is stable so dependent tests can be written against it
  // today.
  void input;
  throw new Error(
    "createBookingWithEarnings is awaiting the earnings-only helper extraction; see __tests__/fixtures/createBookingWithEarnings.ts for the open task.",
  );
}
