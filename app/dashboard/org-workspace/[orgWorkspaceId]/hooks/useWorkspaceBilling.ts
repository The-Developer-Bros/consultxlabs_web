"use client";

import { useQuery } from "@tanstack/react-query";
import type { FundingSource } from "@prisma/client";
import { workspaceBillingQueryKey } from "../workspace-billing-keys";

/**
 * Cross-org billing roll-up — the single source of truth shared by the
 * operator home overview (which reads `.summary`) and the billing page
 * (which reads both `.summary` and `.perOrg`).
 *
 * Both surfaces previously fetched `/api/org-workspace/[id]/billing` under
 * two different query keys ("org-workspace-rollup" vs "org-workspace-billing"),
 * doubling the network request and splitting the cache. One key + one fetcher
 * here collapses that to a single cached entry.
 */

export interface WorkspaceBillingSummary {
  orgsOwned: number;
  totalActiveMembers: number;
  totalOutstandingPaise: number;
  totalWalletPaise: number;
}

export interface WorkspaceBillingPerOrgRow {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  organizationStatus: string;
  fundingSource: FundingSource | null;
  currency: string;
  walletBalancePaise: number;
  outstandingCount: number;
  outstandingPaise: number;
  activeMembers: number;
}

export interface WorkspaceBillingResponse {
  summary: WorkspaceBillingSummary;
  perOrg: WorkspaceBillingPerOrgRow[];
}

async function fetchWorkspaceBilling(
  orgWorkspaceId: string,
): Promise<WorkspaceBillingResponse> {
  const res = await fetch(`/api/org-workspace/${orgWorkspaceId}/billing`);
  if (!res.ok) throw new Error("Failed to load billing roll-up");
  return res.json();
}

export function useWorkspaceBilling(orgWorkspaceId: string) {
  return useQuery({
    queryKey: workspaceBillingQueryKey(orgWorkspaceId),
    queryFn: () => fetchWorkspaceBilling(orgWorkspaceId),
  });
}
