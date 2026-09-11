/**
 * Shared Razorpay type declarations.
 *
 * The global Window.Razorpay declaration is used by:
 * - app/checkout/components/RazorpayCheckout.tsx (existing)
 * - app/dashboard/organization/[orgId]/credits/page.tsx (org credit purchase)
 * - app/dashboard/organization/[orgId]/billing/page.tsx (org invoice payment)
 */

interface RazorpayPaymentResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayPaymentError {
  description?: string;
  code?: string;
  reason?: string;
  message?: string;
}

interface RazorpayFailedResponse {
  error: RazorpayPaymentError;
}

interface RazorpayOptions {
  key: string | undefined;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  handler: (response: RazorpayPaymentResponse) => void;
  prefill?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  theme?: {
    color: string;
  };
}

interface RazorpayInstance {
  on: (
    event: string,
    handler: (response: RazorpayFailedResponse) => void,
  ) => void;
  open: () => void;
}

declare global {
  interface Window {
    Razorpay: new (options: RazorpayOptions) => RazorpayInstance;
  }
}
