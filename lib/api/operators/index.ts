/**
 * Shared utilities for admin + staff ("operator") API routes.
 *
 * The goal is one source of truth for queries and aggregations that power
 * both the admin dashboard and the staff dashboard. Historically these
 * lived as duplicated code across ~13 route file pairs; see the canonical
 * enterprise design doc's follow-up section for the full migration plan.
 *
 * Current migrations:
 *   - [x] getOperatorDashboardStats  ← used by /api/admin/stats
 *   - [x] getStaffDashboardStats     ← used by /api/staff/stats
 *   - [x] getOperatorInvoices        ← used by /api/admin/invoices (both dashboards)
 *   - [x] getOperatorPayouts         ← used by /api/admin/payouts, /api/staff/payouts
 *   - [x] getVerificationQueue       ← used by /api/admin/verification, /api/staff/moderation/profiles
 *   - [ ] getOperatorPayments        ← TODO: unify /api/admin/payments, /api/staff/payments
 *   - [ ] getOperatorDisputes        ← TODO
 *   - [ ] getOperatorFeedback        ← TODO
 *   - [ ] getOperatorSupportTickets  ← TODO
 *
 * The route handlers remain thin shells that call these utilities after
 * running the appropriate auth helper (`requirePrivilegedAuth` or
 * `requireAdminAuth`).
 */

export { getOperatorDashboardStats, getStaffDashboardStats } from "./stats";
export type { OperatorDashboardStats, StaffDashboardStats } from "./stats";

export { getOperatorInvoices } from "./invoices";
export type { OperatorInvoice, OperatorInvoiceResult } from "./invoices";

export { getOperatorPayouts } from "./payouts";
export type { OperatorPayout, OperatorPayoutResult } from "./payouts";

export { getVerificationQueue } from "./verification";
export type { OperatorVerificationResult } from "./verification";
