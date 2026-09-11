/**
 * Shared types for the PurchaseOrders dashboard.
 *
 * Kept narrow on purpose: only the fields the UI consumes. The full
 * Prisma row carries createdAt/updatedAt + FK columns we don't render.
 * If the API surface grows, prefer adding fields here rather than
 * importing Prisma types into client code (Prisma client types pull a
 * lot of generated machinery into the browser bundle).
 */

export type PoStatus = "ACTIVE" | "CLOSED" | "CANCELLED";

export type PoCurrency = "INR" | "USD" | "EUR" | "GBP";

export interface PurchaseOrderRow {
  id: string;
  poNumber: string;
  poDate: string;
  validUntil: string | null;
  totalAmountPaise: number;
  remainingAmountPaise: number;
  currency: PoCurrency;
  status: PoStatus;
  uploadedDocUrl: string | null;
  createdAt: string;
  _count: { invoices: number; contracts: number };
}

export interface CreatePurchaseOrderBody {
  poNumber: string;
  poDate: string;
  validUntil: string | null;
  totalAmountPaise: number;
  currency: PoCurrency;
  uploadedDocUrl: string | null;
}

export interface PatchPurchaseOrderBody {
  status?: PoStatus;
  poDate?: string;
  validUntil?: string | null;
  totalAmountPaise?: number;
  remainingAmountPaise?: number;
  uploadedDocUrl?: string | null;
}
