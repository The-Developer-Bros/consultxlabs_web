import { z } from "zod";
import type { SupportThreadCategory, SupportThreadStatus } from "@prisma/client";

/**
 * Support-thread intents and statuses — ONE definition, previously transcribed
 * into three separate route files where every copy had lost DOCUMENTS. Since
 * `documentsFlow` (lib/support/flows.ts) carries no `available` gate, the GET
 * offered "Session materials" on every appointment and the POST rejected every
 * press. Which intents are OFFERED is the flow registry's decision; these
 * schemas only have to accept whatever it can emit, so no narrowing applies.
 *
 * Guarded in both directions without importing the Prisma client at runtime
 * (this module is pulled into client bundles and jsdom tests):
 *   - `satisfies` below fails to compile on a typo or a removed member;
 *   - __tests__/support/intent-offer-accept-parity.test.ts runs in the node
 *     environment and fails if Prisma gains a member missing from these lists.
 */
const SUPPORT_THREAD_CATEGORIES = [
  "CANCEL_REFUND",
  "RESCHEDULE",
  "NO_SHOW",
  "TECHNICAL",
  "DOCUMENTS",
  "PAYMENT_STATUS",
  "RECORDING_ACCESS",
  "QUALITY_COMPLAINT",
  "SPONSORSHIP_BILLING",
  "ORG_ADMIN_DISPUTE",
  "OTHER",
] as const satisfies readonly SupportThreadCategory[];

const SUPPORT_THREAD_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "ESCALATED",
  "RESOLVED",
  "CLOSED",
] as const satisfies readonly SupportThreadStatus[];

export const SupportThreadCategoryEnum = z.enum(SUPPORT_THREAD_CATEGORIES);
export const SupportThreadStatusEnum = z.enum(SUPPORT_THREAD_STATUSES);

export const CancellationReasonEnum = z.enum([
  "SCHEDULE_CONFLICT",
  "FOUND_ALTERNATIVE",
  "FINANCIAL_REASONS",
  "PERSONAL_EMERGENCY",
  "NO_LONGER_NEEDED",
  "CONSULTANT_UNAVAILABLE",
  "CONSULTANT_EMERGENCY",
  "PAYMENT_FAILED",
  "EXPIRED",
  "OTHER",
]);

export const ProfileVerificationStatusEnum = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "NEEDS_INFO",
]);

export const SupportTicketStatusEnum = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "ON_HOLD",
  "RESOLVED",
  "CLOSED",
]);

export const SupportPriorityEnum = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);

export const SupportIssueTypeEnum = z.enum([
  "CONSULTANT_NO_SHOW",
  "CONSULTANT_LATE",
  "SESSION_ENDED_EARLY",
  "SESSION_QUALITY_POOR",
  "COMMUNICATION_ISSUE",
  "TECHNICAL_ISSUES",
  "WRONG_CONSULTANT",
  "ACCESS_ISSUE",
  "TIMEZONE_CONFUSION",
  "RESCHEDULING_HELP",
  "PAYMENT_FAILED",
  "CHARGED_TWICE",
  "REFUND_REQUEST",
  "BILLING_QUESTION",
  "DOCUMENT_ISSUE",
  "WANT_TO_CANCEL",
  "CANCELLATION_ISSUE",
  "ACCOUNT_ISSUE",
  "GENERAL_INQUIRY",
  "OTHER",
]);

/**
 * Statuses a CLIENT may request via PATCH /api/trials/[trialId].
 *
 * Deliberately narrower than the Prisma `TrialSessionStatus` enum:
 * AWAITING_PAYMENT is server-set only — the accept handler assigns it and the
 * Razorpay webhook clears it — so accepting it from a request body would let a
 * caller mark their own trial as awaiting payment, or worse, sidestep the pay
 * step. Cancelling one still works, because CANCELLED is listed.
 *
 * This list is hand-maintained rather than z.nativeEnum(TrialSessionStatus)
 * precisely so the omission is a decision instead of drift.
 */
export const TrialSessionStatusEnum = z.enum([
  "PENDING",
  "SCHEDULED",
  "COMPLETED",
  "CONVERTED",
  "CANCELLED",
  "REJECTED",
]);

export const RequestStatusEnum = z.enum([
  "PENDING",
  "APPROVED",
  "APPROVED_PENDING_PAYMENT",
  "SCHEDULED",
  "COMPLETED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
]);
