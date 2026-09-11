/**
 * Client-side error type → toast message mapping.
 *
 * Maps the machine-readable `errorType` returned by API routes
 * to user-friendly toast titles and descriptions.
 *
 * Usage:
 *   import { getErrorToast } from "@/lib/payments/error-toast-map";
 *
 *   const { title, description } = getErrorToast(errorType, errorMessage);
 */

import {
  ErrorTypes,
  type ErrorType,
} from "../classification/payment-error-classification";

// ============================================================================
// Toast message definitions
// ============================================================================

interface ToastMessage {
  title: string;
  /** Static description. When null, the raw error message is used. */
  description: string | null;
}

const ERROR_TOAST_MAP: Record<ErrorType, ToastMessage> = {
  [ErrorTypes.PAYMENT_CONFIG]: {
    title: "Payment System Unavailable",
    description:
      "We're unable to connect to the payment system right now. This is a temporary issue on our end. Please try again in a few minutes, or contact support if the problem persists.",
  },
  [ErrorTypes.PAYMENT_PROCESSING]: {
    title: "Payment Could Not Be Processed",
    description:
      "Your payment couldn't be completed. This could be due to insufficient funds, an invalid card, or a temporary bank issue. Please check your payment details and try again, or use a different payment method.",
  },
  [ErrorTypes.DATABASE]: {
    title: "Unable to Save Your Booking",
    description:
      "We encountered an issue while saving your information. Your payment has not been processed. Please refresh the page and try again. If this continues, contact support.",
  },
  [ErrorTypes.NOT_FOUND]: {
    title: "Booking Information Not Found",
    description: null, // Use the server's specific message
  },
  [ErrorTypes.EVENT_EXPIRED]: {
    title: "Event Has Ended",
    description: null, // Use the server's specific message
  },
  [ErrorTypes.AVAILABILITY]: {
    title: "No Longer Available",
    description: null, // Use the server's specific message
  },
  [ErrorTypes.DUPLICATE_REGISTRATION]: {
    title: "Already Registered",
    description:
      "You're already registered for this event! Check your dashboard to view your registration details and upcoming sessions.",
  },
  [ErrorTypes.REFUND_BLOCKED]: {
    title: "Refund Not Allowed",
    description: null, // Use the server's specific message
  },
  [ErrorTypes.LOCK_CONTENTION]: {
    title: "Operation In Progress",
    description: null, // Use the server's specific message
  },
  [ErrorTypes.UNSUPPORTED_CONFIG]: {
    title: "Configuration Not Supported",
    description: null, // Use the server's specific message
  },
  // #1351 — the server message names the env flag that fences the rail, which
  // is operator detail, so this entry carries its own description instead of
  // passing that through to the buyer.
  [ErrorTypes.GATEWAY_UNAVAILABLE]: {
    title: "This payment method is not available",
    description:
      "This payment method isn't available right now. Please go back and choose a different one.",
  },
  // #1426 — the buyer's card was never charged in any of these three
  // rejections, so each toast says so and points at the one action that
  // actually unblocks the buyer, instead of the generic gateway copy above.
  [ErrorTypes.WALLET_FROZEN]: {
    title: "Wallet On Hold",
    description:
      "Your organisation's wallet is frozen; ask your billing admin or support before booking again.",
  },
  [ErrorTypes.CONSENT_REQUIRED]: {
    title: "Booking Not Available",
    description:
      "This consultant has not enabled bookings yet; you can try another consultant or check back later.",
  },
  [ErrorTypes.CONSENT_WITHDRAWN]: {
    title: "Booking Not Available",
    description:
      "This consultant has paused bookings; your card was not charged.",
  },
  // #1407 — the fix is an admin action on the organisation, not a retry, so the
  // copy names it rather than inviting the buyer to try again.
  [ErrorTypes.DOMAIN_VERIFICATION_REQUIRED]: {
    title: "Domain Verification Required",
    description:
      "Invoice funding needs a verified domain on your organisation; ask your billing admin to verify it, or pay by card instead. Your card was not charged.",
  },
  // #1458 — the programme ran out of budget or was configured with a rail we do
  // not collect on. Neither is fixed by retrying, so each toast names the person
  // who can actually unblock the booking.
  [ErrorTypes.PROGRAM_CAP_EXHAUSTED]: {
    title: "Programme Budget Used Up",
    description:
      "Your organisation's programme budget for this cycle is used up; ask your admin or pay yourself if allowed.",
  },
  [ErrorTypes.PROGRAM_SESSION_CAP_REACHED]: {
    title: "Programme Session Cap Reached",
    description: null, // The server message already names the admin action.
  },
  [ErrorTypes.OVERAGE_CHARGE_MEMBER_UNSUPPORTED]: {
    title: "Programme Not Bookable Past Its Cap",
    description:
      "This programme is set to charge members for bookings past its cap, which is not available on a wallet-funded organisation. Ask your billing admin to switch the programme to charge the organisation or to block over-cap bookings.",
  },
  // #1467 — the organisation's entitlement, not the booking, is what stops
  // these. Retrying changes nothing, so each toast names the admin who can.
  [ErrorTypes.PROGRAM_ASSIGNMENT_INACTIVE]: {
    title: "No Programme Covers This Booking",
    description:
      "Your organisation has no active programme assignment for this session type, usually because its contract or programme has ended. Ask your organisation admin to assign you to a programme that covers it, or book it yourself. You were not charged.",
  },
  [ErrorTypes.BILLING_SUSPENDED_DUNNING]: {
    title: "Organisation Billing Suspended",
    description:
      "Your organisation has an overdue invoice, so new sponsored bookings are paused until it is paid. Ask your billing admin to settle it, or book this session yourself. You were not charged.",
  },
  // #1477 — the wallet is fine, it is simply short, so the copy asks for the
  // one action that clears it rather than inviting a retry that cannot succeed.
  [ErrorTypes.WALLET_INSUFFICIENT_FUNDS]: {
    title: "Wallet Balance Too Low",
    description:
      "Your organisation's wallet does not cover this booking. Ask your billing admin to top it up.",
  },
  [ErrorTypes.UNKNOWN]: {
    title: "Something Went Wrong",
    description: null, // Use the server's specific message
  },
};

// ============================================================================
// Gateway refund codes
// ============================================================================

/**
 * #1352 — `RefundError.code` values are minted by the gateway adapter and
 * travel to the client as `code`, never through `classifyError`. They therefore
 * arrived here as an unrecognised string and fell straight through to
 * "Something Went Wrong".
 *
 * `REFUND_IN_FLIGHT` is the one where that was actively misleading. Razorpay
 * answers 409 on a duplicate idempotency key while the original refund is still
 * settling, which means the refund IS happening — telling the operator (or the
 * customer) that something went wrong invites them to issue a second one.
 */
const REFUND_CODE_TOAST_MAP: Record<string, ToastMessage> = {
  REFUND_IN_FLIGHT: {
    title: "Refund Already In Progress",
    description:
      "Your refund is already being processed and does not need to be requested again. " +
      "It can take a few moments to settle with the bank — refresh this page shortly to see the updated status.",
  },
};

// ============================================================================
// Fallback descriptions (used when the toast entry has description: null
// AND no server error message is available)
// ============================================================================

const FALLBACK_DESCRIPTIONS: Partial<Record<ErrorType, string>> = {
  [ErrorTypes.NOT_FOUND]:
    "The item you're trying to book could not be found. It may have been removed or is no longer available. Please go back and select a different option.",
  [ErrorTypes.EVENT_EXPIRED]:
    "This event has already ended or been cancelled and is no longer accepting registrations. Please browse other upcoming events.",
  [ErrorTypes.AVAILABILITY]:
    "This booking is no longer available. Someone else may have just booked it, or the schedule has changed. Please go back and select a different time slot or option.",
  [ErrorTypes.UNKNOWN]:
    "An unexpected error occurred while processing your request. Please try again. If the problem continues, take a screenshot of this message and contact support.",
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Resolve an errorType + optional message into a toast-ready { title, description }.
 *
 * `errorType` is a string rather than the `ErrorType` union because API routes
 * also return gateway-minted `RefundError.code` values here (#1352); those are
 * matched first, then the classified error types, then the UNKNOWN fallback.
 */
export function getErrorToast(
  errorType: string,
  serverMessage?: string,
): { title: string; description: string } {
  const entry =
    REFUND_CODE_TOAST_MAP[errorType] ??
    ERROR_TOAST_MAP[errorType as ErrorType] ??
    ERROR_TOAST_MAP[ErrorTypes.UNKNOWN];

  const description =
    entry.description ??
    serverMessage ??
    FALLBACK_DESCRIPTIONS[errorType as ErrorType] ??
    FALLBACK_DESCRIPTIONS[ErrorTypes.UNKNOWN]!;

  return { title: entry.title, description };
}
