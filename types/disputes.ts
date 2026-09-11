/**
 * Shared types for Dispute API responses.
 * Used by admin/disputes, staff/disputes and their detail pages.
 */

/**
 * Represents a JSON value from Prisma's Json type.
 * Used for fields like `evidence` and `metadata` that store arbitrary JSON.
 */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Dispute {
  id: string;
  disputeId: string;
  /** Paise. Was declared as `amount`, which the API never returned. */
  amountPaise: number;
  currency: string;
  status: string;
  reason: string | null;
  paymentGateway: string;
  dueBy: string | null;
  createdAt: string;
  payment: {
    id: string;
    paymentIntent: string;
  } | null;
}

export interface DisputeListResponse {
  disputes: Dispute[];
  total: number;
  urgentDisputes: number;
  // #997 secondary findings — dashboard-wide counts (unfiltered by the
  // current search/status/gateway), like `urgentDisputes` above.
  stats: {
    underReviewCount: number;
    wonCount: number;
  };
  page: number;
  limit: number;
  totalPages: number;
}

export interface DisputeDetails {
  id: string;
  disputeId: string;
  /** Paise. Was declared as `amount`, which the API never returned. */
  amountPaise: number;
  currency: string;
  status: string;
  reason: string | null;
  paymentGateway: string;
  paymentId: string;
  dueBy: string | null;
  isChargeRefundable: boolean;
  evidence: JsonValue | null;
  evidenceSubmittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  payment: {
    id: string;
    paymentIntent: string;
    paymentStatus: string;
    amount: number;
    currency: string;
    paymentMethod: string | null;
    createdAt: string;
    user: {
      id: string;
      name: string | null;
      email: string;
    };
  } | null;
}
