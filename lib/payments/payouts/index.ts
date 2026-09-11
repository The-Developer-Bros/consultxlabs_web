/**
 * Payout System Exports
 * Central export point for all payout-related functionality
 */

// Constants
export { PAYOUT_CONSTANTS, TAX_CONSTANTS, PAYOUT_MODES } from "./constants";
export type { AppointmentType } from "./constants";

// RazorpayX Payouts
export {
  RazorpayPayoutsService,
  getRazorpayPayoutsService,
  isRazorpayPayoutsConfigured,
} from "./razorpay-payouts";
export type { Contact, RazorpayPayout } from "./razorpay-payouts";

// Stripe Connect
export {
  StripeConnectService,
  getStripeConnectService,
  isStripeConnectConfigured,
} from "./stripe-connect";
export type { AccountLink } from "./stripe-connect";

// Payout Service
export {
  getPendingPayouts,
  getPayoutById,
  checkPayoutEligibility,
  createPayoutBatch,
  approvePayout,
  rejectPayout,
  processApprovedPayouts,
  handlePayoutWebhook,
  markConsultantPayoutReversed,
  getPayoutStats,
} from "./payout-service";
export type { PayoutResult } from "./payout-service";

// Org Payout Service
export {
  getOrgPayoutEligibility,
  createOrgPayoutBatch,
  processOrgPayout,
  processPendingOrgPayouts,
  markOrgPayoutCompleted,
  markOrgPayoutFailed,
  markOrgPayoutReversed,
} from "./org-payout-service";
export type { OrgProcessingResult } from "./org-payout-service";

// Earnings Service
export {
  createEarningsFromPayment,
  resolvePaymentForEarnings,
  getConsultantEarningsSummary,
  getConsultantEarnings,
  refundEarnings,
  holdEarnings,
  releaseHeldEarnings,
  getEarningsStats,
  // Organization earnings (PROVIDER/HYBRID 3-way split)
  getOrgEarningsSummary,
  getOrgEarnings,
} from "./earnings-service";
