/**
 * Client-side fetch helpers for the PurchaseOrders dashboard.
 *
 * Single source of truth for the API contract: the rest of the
 * dashboard imports these and never calls `fetch` inline. Each helper
 * throws the server-returned `{ error }` string when the response is
 * non-2xx so the React Query `onError` handlers can surface them.
 */

import type {
  CreatePurchaseOrderBody,
  PatchPurchaseOrderBody,
  PoStatus,
  PurchaseOrderRow,
} from "./types";

export async function fetchPurchaseOrders(
  orgId: string,
  status: PoStatus | "ALL",
): Promise<{ data: PurchaseOrderRow[] }> {
  const url = new URL(
    `/api/organizations/${orgId}/billing-account/purchase-orders`,
    window.location.origin,
  );
  if (status !== "ALL") url.searchParams.set("status", status);
  const res = await fetch(url.pathname + url.search);
  if (!res.ok) throw new Error("Failed to load purchase orders");
  return res.json();
}

export async function createPurchaseOrder(
  orgId: string,
  body: CreatePurchaseOrderBody,
) {
  const res = await fetch(
    `/api/organizations/${orgId}/billing-account/purchase-orders`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (json as { error?: string }).error ?? "Failed to create purchase order",
    );
  }
  return json;
}

export async function patchPurchaseOrder(
  orgId: string,
  poId: string,
  body: PatchPurchaseOrderBody,
) {
  const res = await fetch(
    `/api/organizations/${orgId}/billing-account/purchase-orders/${poId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (json as { error?: string }).error ?? "Failed to update purchase order",
    );
  }
  return json;
}

export async function deletePurchaseOrder(orgId: string, poId: string) {
  const res = await fetch(
    `/api/organizations/${orgId}/billing-account/purchase-orders/${poId}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(
      (json as { error?: string }).error ?? "Failed to delete purchase order",
    );
  }
}
