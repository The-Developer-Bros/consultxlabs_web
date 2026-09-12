import { PaymentIntentParams, PaymentIntent } from "../core/types";
import { PaymentGateway } from "@prisma/client";

/**
 * Mock Payment Operations
 * Used in development to create payment records without calling actual payment gateways
 */

// ============================================================================
// Mock Payment Creation
// ============================================================================

/**
 * Create a mock payment intent for development/testing
 * This creates a fake payment ID that looks like the real gateway's ID format
 * but doesn't actually call the payment gateway API
 */
export async function createMockPaymentIntent({
  amount,
  currency,
  metadata: _metadata,
  paymentGateway,
}: PaymentIntentParams): Promise<PaymentIntent> {
  // Simulate a small delay like a real API call
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Generate mock payment ID based on gateway
  const mockPaymentId = generateMockPaymentId(paymentGateway);

  return {
    id: mockPaymentId,
    client_secret: `mock_secret_${mockPaymentId}`,
    amount,
    currency,
    status: "succeeded", // Mock payments are always successful
  };
}

/**
 * Generate mock payment ID that matches gateway format
 */
function generateMockPaymentId(gateway: PaymentGateway): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);

  switch (gateway) {
    case "STRIPE":
      return `cs_mock_${random}_${timestamp}`;

    case "RAZORPAY":
      return `order_mock_${random}${timestamp}`;

    default:
      return `mock_${random}_${timestamp}`;
  }
}

/**
 * Check if a payment intent ID is a mock payment
 */
export function isMockPaymentId(paymentIntentId: string): boolean {
  return paymentIntentId.includes("_mock_");
}

/**
 * Mock cancel payment (no-op for mock payments)
 */
export async function cancelMockPayment(
  paymentIntentId: string,
): Promise<void> {
  console.log(`✅ Mock payment cancelled: ${paymentIntentId}`);
  // No actual work needed for mock payments
}

/**
 * Validate mock payment metadata
 */
export function validateMockPaymentMetadata(
  metadata: Record<string, string>,
): boolean {
  // Check required fields
  if (!metadata.appointmentId || !metadata.appointmentType) {
    return false;
  }

  return true;
}

/**
 * Get mock payment details (for testing)
 */
export async function getMockPaymentDetails(paymentIntentId: string): Promise<{
  id: string;
  status: string;
  amount: number;
  currency: string;
}> {
  // Simulate API delay
  await new Promise((resolve) => setTimeout(resolve, 200));

  return {
    id: paymentIntentId,
    status: "succeeded",
    amount: 0, // Mock amount not tracked
    currency: "USD",
  };
}

// ============================================================================
// Mock Refund Operations
// ============================================================================

/**
 * Create a mock refund (for development)
 */
export async function createMockRefund(
  paymentIntentId: string,
  amount?: number,
  _reason?: string,
): Promise<{
  refundId: string;
  amount: number;
  status: string;
}> {
  // Simulate API delay
  await new Promise((resolve) => setTimeout(resolve, 300));

  const mockRefundId = `rfnd_mock_${Math.random().toString(36).substring(2, 15)}`;

  console.log(
    `✅ Mock refund created: ${mockRefundId} for payment ${paymentIntentId}`,
  );

  return {
    refundId: mockRefundId,
    amount: amount || 0,
    status: "succeeded",
  };
}

// ============================================================================
// Environment Checks
// ============================================================================

/**
 * Check if mock payments should be enabled. Single server-side source of truth
 * consumed by createPaymentIntent (lib/payments/index.ts) and, through the
 * app/checkout/plans/mockPay re-export, by the checkout route and the client
 * Mock Pay buttons.
 *
 * Local development and Netlify deploy previews / branch deploys are always
 * enabled. `CONTEXT` (deploy-preview / branch-deploy) is server-side only —
 * it is replaced with `undefined` in client bundles, which is why the preview
 * flag is ALSO exported as NEXT_PUBLIC_MOCK_PAYMENTS_ENABLED via netlify.toml
 * for the client button to see. Production is never enabled.
 */
export function shouldEnableMockPayments(): boolean {
  if (process.env.NODE_ENV === "development") return true;

  const context = process.env.CONTEXT as string | undefined;
  if (context === "deploy-preview" || context === "branch-deploy") return true;

  return (
    process.env.ENABLE_MOCK_PAYMENTS === "true" ||
    process.env.NEXT_PUBLIC_MOCK_PAYMENTS_ENABLED === "true"
  );
}

/**
 * Log mock payment warning
 */
export function logMockPaymentWarning(gateway: PaymentGateway): void {
  console.warn(`
    ⚠️  MOCK PAYMENT MODE ENABLED ⚠️
    Gateway: ${gateway}
    This payment will NOT be processed through the actual payment gateway.
    A mock payment record will be created with SUCCEEDED status.

    This should ONLY be used in development/testing.
  `);
}
