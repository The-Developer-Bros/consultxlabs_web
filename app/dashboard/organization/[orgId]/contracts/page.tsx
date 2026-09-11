"use client";

import { use, useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, FileText, Loader2, Check, X, Eye, Pencil, Lock } from "lucide-react";
import type { ContractStatus } from "@prisma/client";

import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContractItem {
  id: string;
  status: ContractStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  paymentTermsDays: number;
  autoRenew: boolean;
  signedAt: string | null;
  createdAt: string;
  billingAccount: {
    id: string;
    fundingSource: string;
    currency: string;
  } | null;
  purchaseOrder: {
    id: string;
    poNumber: string;
    status: string;
  } | null;
  programs: Array<{ id: string; name: string; type: string; status: string }>;
  subscription: {
    id: string;
    model: "PER_SEAT" | "FLAT_FEE";
    cycle: "MONTHLY" | "QUARTERLY" | "ANNUAL";
    flatFeePaise: number | null;
  } | null;
  _count: { programs: number };
}

interface BillingAccount {
  id: string;
  fundingSource: string;
  currency: string;
}

// ---------------------------------------------------------------------------
// API layer
// ---------------------------------------------------------------------------

async function fetchContracts(orgId: string): Promise<{ data: ContractItem[] }> {
  const res = await fetch(`/api/organizations/${orgId}/contracts`);
  if (!res.ok) throw new Error("Failed to load contracts");
  return res.json();
}

async function fetchBillingAccount(orgId: string): Promise<{ billingAccount: BillingAccount }> {
  const res = await fetch(`/api/organizations/${orgId}/billing-account`);
  if (!res.ok) throw new Error("Failed to load billing account");
  return res.json();
}

async function createContract(
  orgId: string,
  body: {
    billingAccountId: string;
    effectiveFrom: string;
    effectiveTo?: string | null;
    paymentTermsDays?: number;
    autoRenew: boolean;
    status: "DRAFT" | "ACTIVE";
    licenseFeePaise?: number;
    licenseCycle?: "MONTHLY" | "QUARTERLY" | "ANNUAL";
  },
) {
  const res = await fetch(`/api/organizations/${orgId}/contracts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((json as { error?: string }).error ?? "Failed to create contract");
  }
  return json;
}

async function patchContract(
  orgId: string,
  contractId: string,
  body: { status?: ContractStatus; signedAt?: string | null },
) {
  const res = await fetch(`/api/organizations/${orgId}/contracts/${contractId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((json as { error?: string }).error ?? "Failed to update contract");
  }
  return json;
}

async function deleteContract(orgId: string, contractId: string) {
  const res = await fetch(`/api/organizations/${orgId}/contracts/${contractId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error((json as { error?: string }).error ?? "Failed to delete contract");
  }
}

// Single-contract GET carries the server-derived `locked` flag so the
// detail/edit drawer can disable term fields without re-deriving the rule
// client-side (#777 §B).
type ContractDetail = ContractItem & { locked: boolean };

async function fetchContract(
  orgId: string,
  contractId: string,
): Promise<{ contract: ContractDetail }> {
  const res = await fetch(`/api/organizations/${orgId}/contracts/${contractId}`);
  if (!res.ok) throw new Error("Failed to load contract");
  return res.json();
}

// Edit PATCH — autoRenew always allowed; the term fields only go through
// when the contract isn't locked. The server re-checks and 409s
// CONTRACT_TERMS_LOCKED if a locked term field slips past.
async function editContract(
  orgId: string,
  contractId: string,
  body: {
    autoRenew?: boolean;
    effectiveFrom?: string;
    effectiveTo?: string | null;
    paymentTermsDays?: number;
  },
) {
  const res = await fetch(`/api/organizations/${orgId}/contracts/${contractId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((json as { error?: string }).error ?? "Failed to update contract");
  }
  return json;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const STATUS_BADGE: Record<ContractStatus, string> = {
  DRAFT: "bg-muted text-muted-foreground border-border",
  ACTIVE:
    "bg-green-50 text-green-800 border-green-300 dark:bg-green-950 dark:text-green-300 dark:border-green-800",
  EXPIRED:
    "bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
  TERMINATED:
    "bg-red-50 text-red-700 border-red-300 dark:bg-red-950 dark:text-red-300 dark:border-red-800",
};

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

function CreateContractDialog({
  orgId,
  billingAccountId,
  fundingSource,
  open,
  onOpenChange,
}: {
  orgId: string;
  billingAccountId: string;
  fundingSource: string | undefined;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [effectiveTo, setEffectiveTo] = useState("");
  const [paymentTermsDays, setPaymentTermsDays] = useState("60");
  const [autoRenew, setAutoRenew] = useState(false);
  const [status, setStatus] = useState<"DRAFT" | "ACTIVE">("ACTIVE");
  const [licenseFeeINR, setLicenseFeeINR] = useState("");
  const [licenseCycle, setLicenseCycle] = useState<
    "MONTHLY" | "QUARTERLY" | "ANNUAL"
  >("ANNUAL");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setEffectiveFrom(today);
    setEffectiveTo("");
    setPaymentTermsDays("60");
    setAutoRenew(false);
    setStatus("ACTIVE");
    setLicenseFeeINR("");
    setLicenseCycle("ANNUAL");
    setError(null);
  };

  const createMutation = useMutation({
    mutationFn: (body: Parameters<typeof createContract>[1]) =>
      createContract(orgId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-contracts", orgId] });
      // Also invalidate the active-contracts cache used by Programs page.
      queryClient.invalidateQueries({ queryKey: ["org-contracts-active", orgId] });
      reset();
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = () => {
    setError(null);
    const isLicense = fundingSource === "LICENSE";
    // LICENSE-funded orgs don't see the payment-terms field (annual fee
    // is paid upfront, not on net-X terms). Skip validation and omit
    // the field from the payload so the server's default(60) applies —
    // otherwise stale text typed before switching to LICENSE would fire
    // a hidden-field error.
    let terms: number | undefined;
    if (!isLicense) {
      const parsed = parseInt(paymentTermsDays, 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 120) {
        setError("Payment terms must be between 1 and 120 days.");
        return;
      }
      terms = parsed;
    }
    if (effectiveTo && new Date(effectiveTo) <= new Date(effectiveFrom)) {
      setError("End date must be after the start date.");
      return;
    }
    let licenseFeePaise: number | undefined;
    if (isLicense && licenseFeeINR.trim() !== "") {
      const inr = parseFloat(licenseFeeINR);
      if (!Number.isFinite(inr) || inr <= 0) {
        setError("License fee must be a positive number (₹).");
        return;
      }
      licenseFeePaise = Math.round(inr * 100);
    }
    createMutation.mutate({
      billingAccountId,
      effectiveFrom: new Date(effectiveFrom).toISOString(),
      effectiveTo: effectiveTo ? new Date(effectiveTo).toISOString() : null,
      ...(terms !== undefined ? { paymentTermsDays: terms } : {}),
      autoRenew,
      status,
      ...(licenseFeePaise !== undefined
        ? { licenseFeePaise, licenseCycle }
        : {}),
    });
  };

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <ResponsiveModalContent className="sm:max-w-md max-h-[90vh] overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>New Contract</ResponsiveModalTitle>
        </ResponsiveModalHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="effective-from">Effective from *</Label>
              <Input
                id="effective-from"
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="effective-to">Effective to</Label>
              <Input
                id="effective-to"
                type="date"
                value={effectiveTo}
                onChange={(e) => setEffectiveTo(e.target.value)}
                placeholder="Open-ended"
              />
              <p className="text-xs text-muted-foreground">Leave blank for open-ended</p>
            </div>
          </div>

          {fundingSource !== "LICENSE" && (
            <div className="space-y-1.5">
              <Label htmlFor="payment-terms">Payment terms (days) *</Label>
              <Input
                id="payment-terms"
                type="number"
                min={1}
                max={120}
                value={paymentTermsDays}
                onChange={(e) => setPaymentTermsDays(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                NET-{paymentTermsDays || "?"} — how many days after invoice date the org must pay.
              </p>
            </div>
          )}

          {fundingSource === "LICENSE" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="license-fee">License fee (₹/year)</Label>
                <Input
                  id="license-fee"
                  type="number"
                  min={1}
                  step="1"
                  placeholder="e.g. 7500000"
                  value={licenseFeeINR}
                  onChange={(e) => setLicenseFeeINR(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Optional. Recording the fee enables annual renewal billing
                  and dashboard display. Skipping is reversible only by
                  terminating this contract and creating a new one.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="license-cycle">Billing cycle</Label>
                <select
                  id="license-cycle"
                  className="flex h-10 w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
                  value={licenseCycle}
                  onChange={(e) =>
                    setLicenseCycle(
                      e.target.value as "MONTHLY" | "QUARTERLY" | "ANNUAL",
                    )
                  }
                >
                  <option value="ANNUAL">Annual</option>
                  <option value="QUARTERLY">Quarterly</option>
                  <option value="MONTHLY">Monthly</option>
                </select>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>Initial status</Label>
            <div className="flex gap-2">
              {(["ACTIVE", "DRAFT"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                    status === s
                      ? "border-foreground bg-foreground text-background"
                      : "border-border hover:border-foreground/40"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              ACTIVE contracts can immediately attach Programs. DRAFT contracts need to be activated first.
            </p>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={autoRenew}
              onCheckedChange={(v) => setAutoRenew(v === true)}
            />
            <span className="text-sm">Auto-renew when effective-to date passes</span>
          </label>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <ResponsiveModalFooter>
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={createMutation.isPending}>
            {createMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-1" /> Creating…
              </>
            ) : (
              "Create"
            )}
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}

// ---------------------------------------------------------------------------
// Detail drawer (#777 §B) — read-only view of a single contract: status,
// effective window, payment terms (Prepaid for LICENSE), auto-renew, and the
// programs / subscription riding on it.
// ---------------------------------------------------------------------------

// LICENSE contracts pay the flat fee upfront, so net-X payment terms don't
// apply — render "Prepaid" rather than a misleading NET-0 or em-dash.
function fmtPaymentTerms(c: Pick<ContractItem, "paymentTermsDays" | "billingAccount">): string {
  if (c.billingAccount?.fundingSource === "LICENSE") return "Prepaid";
  return `NET-${c.paymentTermsDays}`;
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{children}</span>
    </div>
  );
}

function ContractDetailDialog({
  orgId,
  contractId,
  open,
  onOpenChange,
}: {
  orgId: string;
  contractId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const detail = useQuery({
    queryKey: ["org-contract", orgId, contractId],
    queryFn: () => fetchContract(orgId, contractId),
    enabled: open,
  });
  const c = detail.data?.contract;

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="sm:max-w-md max-h-[85vh] overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Contract detail</ResponsiveModalTitle>
        </ResponsiveModalHeader>

        {detail.isLoading || !c ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-4">
            <div className="divide-y rounded-md border px-3">
              <DetailRow label="Status">
                <Badge variant="outline" className={STATUS_BADGE[c.status]}>
                  {c.status}
                </Badge>
              </DetailRow>
              <DetailRow label="Funding">
                {c.billingAccount?.fundingSource ?? "—"}
              </DetailRow>
              <DetailRow label="Effective from">
                {fmtDate(c.effectiveFrom)}
              </DetailRow>
              <DetailRow label="Effective to">
                {c.effectiveTo ? fmtDate(c.effectiveTo) : "open-ended"}
              </DetailRow>
              <DetailRow label="Payment terms">{fmtPaymentTerms(c)}</DetailRow>
              <DetailRow label="Auto-renew">{c.autoRenew ? "Yes" : "No"}</DetailRow>
              {c.subscription && (
                <DetailRow label="Subscription">
                  {c.subscription.model === "FLAT_FEE" &&
                  c.subscription.flatFeePaise != null
                    ? `₹${(c.subscription.flatFeePaise / 100).toLocaleString("en-IN")} / ${c.subscription.cycle.toLowerCase()}`
                    : `${c.subscription.model} / ${c.subscription.cycle.toLowerCase()}`}
                </DetailRow>
              )}
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-semibold">
                Programs ({c.programs.length})
              </h4>
              {c.programs.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No programs attached to this contract.
                </p>
              ) : (
                <ul className="space-y-1">
                  {c.programs.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm"
                    >
                      <span>{p.name}</span>
                      <Badge variant="secondary" className="text-xs">
                        {p.type}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        <ResponsiveModalFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}

// ---------------------------------------------------------------------------
// Edit dialog (#777 §B) — autoRenew editable always; effective dates and
// payment terms only while the contract isn't locked (still DRAFT, unsigned,
// no invoices / live assignments). The lock is server-derived.
// ---------------------------------------------------------------------------

function ContractLockedHint() {
  return (
    <span className="ml-2 inline-flex items-center gap-1 text-xs text-amber-600">
      <Lock className="h-3 w-3" /> Locked — in use
    </span>
  );
}

function EditContractDialog({
  orgId,
  contractId,
  open,
  onOpenChange,
}: {
  orgId: string;
  contractId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["org-contract", orgId, contractId],
    queryFn: () => fetchContract(orgId, contractId),
    enabled: open,
  });
  const c = detail.data?.contract;
  const locked = c?.locked ?? true; // fail-safe: lock until we know
  const isLicense = c?.billingAccount?.fundingSource === "LICENSE";

  const [autoRenew, setAutoRenew] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");
  const [paymentTermsDays, setPaymentTermsDays] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!c) return;
    setAutoRenew(c.autoRenew);
    setEffectiveFrom(c.effectiveFrom.slice(0, 10));
    setEffectiveTo(c.effectiveTo ? c.effectiveTo.slice(0, 10) : "");
    setPaymentTermsDays(String(c.paymentTermsDays));
    setError(null);
  }, [c]);

  const editMutation = useMutation({
    mutationFn: (body: Parameters<typeof editContract>[2]) =>
      editContract(orgId, contractId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-contracts", orgId] });
      queryClient.invalidateQueries({ queryKey: ["org-contracts-active", orgId] });
      queryClient.invalidateQueries({
        queryKey: ["org-contract", orgId, contractId],
      });
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = () => {
    setError(null);
    if (!c) return;
    // autoRenew is the only always-safe field. Term fields ride along only
    // when unlocked — the server is the final authority either way.
    const body: Parameters<typeof editContract>[2] = { autoRenew };
    if (!locked) {
      // A cleared/garbled date input is an empty string — new Date("") is an
      // Invalid Date and .toISOString() on it throws. Validate before use.
      const fromDate = new Date(effectiveFrom);
      if (!effectiveFrom || Number.isNaN(fromDate.getTime())) {
        setError("Start date is required.");
        return;
      }
      const toDate = effectiveTo ? new Date(effectiveTo) : null;
      if (toDate && Number.isNaN(toDate.getTime())) {
        setError("End date is invalid.");
        return;
      }
      if (toDate && toDate <= fromDate) {
        setError("End date must be after the start date.");
        return;
      }
      body.effectiveFrom = fromDate.toISOString();
      body.effectiveTo = toDate ? toDate.toISOString() : null;
      // LICENSE terms are prepaid — don't send paymentTermsDays for them.
      if (!isLicense) {
        const parsed = parseInt(paymentTermsDays, 10);
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 120) {
          setError("Payment terms must be between 1 and 120 days.");
          return;
        }
        body.paymentTermsDays = parsed;
      }
    }
    editMutation.mutate(body);
  };

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="sm:max-w-md max-h-[85vh] overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Edit contract</ResponsiveModalTitle>
        </ResponsiveModalHeader>

        {detail.isLoading || !c ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-4">
            {locked && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                This contract is in use (signed, invoiced, or with live
                assignments). Effective dates and payment terms are locked —
                only auto-renew can be changed.
              </p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-effective-from">
                  Effective from
                  {locked && <ContractLockedHint />}
                </Label>
                <Input
                  id="edit-effective-from"
                  type="date"
                  disabled={locked}
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-effective-to">
                  Effective to
                  {locked && <ContractLockedHint />}
                </Label>
                <Input
                  id="edit-effective-to"
                  type="date"
                  disabled={locked}
                  value={effectiveTo}
                  onChange={(e) => setEffectiveTo(e.target.value)}
                  placeholder="Open-ended"
                />
              </div>
            </div>

            {!isLicense && (
              <div className="space-y-1.5">
                <Label htmlFor="edit-payment-terms">
                  Payment terms (days)
                  {locked && <ContractLockedHint />}
                </Label>
                <Input
                  id="edit-payment-terms"
                  type="number"
                  min={1}
                  max={120}
                  disabled={locked}
                  value={paymentTermsDays}
                  onChange={(e) => setPaymentTermsDays(e.target.value)}
                />
              </div>
            )}

            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={autoRenew}
                onCheckedChange={(v) => setAutoRenew(v === true)}
              />
              <span className="text-sm">
                Auto-renew when effective-to date passes
              </span>
            </label>

            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        )}

        <ResponsiveModalFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={editMutation.isPending || detail.isLoading || !c}
          >
            {editMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OrgContractsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const { isAtLeast } = useOrgRole(orgId);
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "contracts.read",
    canSponsor: true,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [detailTarget, setDetailTarget] = useState<ContractItem | null>(null);
  const [editTarget, setEditTarget] = useState<ContractItem | null>(null);
  const [activateTarget, setActivateTarget] = useState<ContractItem | null>(null);
  const [terminateTarget, setTerminateTarget] = useState<ContractItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ContractItem | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const queryClient = useQueryClient();

  const contracts = useQuery({
    queryKey: ["org-contracts", orgId],
    queryFn: () => fetchContracts(orgId),
    enabled: allowed,
  });

  const billingAccount = useQuery({
    queryKey: ["org-billing-account", orgId],
    queryFn: () => fetchBillingAccount(orgId),
    enabled: allowed && isAtLeast("OWNER"),
  });

  const patchMutation = useMutation({
    mutationFn: ({
      contractId,
      body,
    }: {
      contractId: string;
      body: { status?: ContractStatus; signedAt?: string | null };
    }) => patchContract(orgId, contractId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-contracts", orgId] });
      queryClient.invalidateQueries({ queryKey: ["org-contracts-active", orgId] });
      setActivateTarget(null);
      setTerminateTarget(null);
      setActionError(null);
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (contractId: string) => deleteContract(orgId, contractId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-contracts", orgId] });
      queryClient.invalidateQueries({ queryKey: ["org-contracts-active", orgId] });
      setDeleteTarget(null);
      setActionError(null);
    },
    onError: (err: Error) => setActionError(err.message),
  });

  if (!allowed) return null;

  const contractList = contracts.data?.data ?? [];
  const billingAccountId = billingAccount.data?.billingAccount?.id ?? "";
  const canCreate = isAtLeast("OWNER") && !!billingAccountId;
  const canManage = isAtLeast("OWNER");

  const columns: ResponsiveColumn<ContractItem>[] = [
    {
      key: "status",
      header: "Status",
      primary: true,
      cell: (c) => (
        <Badge variant="outline" className={STATUS_BADGE[c.status]}>
          {c.status}
        </Badge>
      ),
    },
    {
      key: "funding",
      header: "Funding",
      className: "text-sm text-muted-foreground",
      cell: (c) => c.billingAccount?.fundingSource ?? "—",
    },
    {
      key: "period",
      header: "Period",
      className: "text-sm text-muted-foreground whitespace-nowrap",
      cell: (c) => (
        <>
          {fmtDate(c.effectiveFrom)} →{" "}
          {c.effectiveTo ? fmtDate(c.effectiveTo) : "open-ended"}
        </>
      ),
    },
    {
      key: "terms",
      header: "Terms",
      className: "text-sm text-muted-foreground",
      cell: (c) => (
        <>
          {c.billingAccount?.fundingSource === "LICENSE"
            ? c.subscription?.flatFeePaise != null
              ? `₹${(c.subscription.flatFeePaise / 100).toLocaleString("en-IN")} / ${c.subscription.cycle.toLowerCase()}`
              : "—"
            : `NET-${c.paymentTermsDays}`}
          {c.autoRenew && (
            <span className="ml-1 text-xs text-muted-foreground/70">(auto-renew)</span>
          )}
        </>
      ),
    },
    {
      key: "programs",
      header: "Programs",
      className: "text-sm",
      cell: (c) =>
        c._count.programs > 0 ? (
          <span className="text-foreground">{c._count.programs}</span>
        ) : (
          <span className="text-muted-foreground/70">—</span>
        ),
    },
  ];

  const renderRowActions = (c: ContractItem) => (
    <div className="flex items-center justify-end gap-1">
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setDetailTarget(c)}
        title="View detail"
      >
        <Eye className="h-3.5 w-3.5 mr-1" /> View
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setActionError(null);
          setEditTarget(c);
        }}
      >
        <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
      </Button>
      {c.status === "DRAFT" && (
        <>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setActionError(null);
              setActivateTarget(c);
            }}
          >
            <Check className="h-3.5 w-3.5 mr-1" /> Activate
          </Button>
          {c._count.programs === 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
              onClick={() => {
                setActionError(null);
                setDeleteTarget(c);
              }}
            >
              <X className="h-3.5 w-3.5 mr-1" /> Delete
            </Button>
          )}
        </>
      )}
      {c.status === "ACTIVE" && (
        <Button
          size="sm"
          variant="ghost"
          className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
          onClick={() => {
            setActionError(null);
            setTerminateTarget(c);
          }}
        >
          Terminate
        </Button>
      )}
    </div>
  );

  return (
    <>
      <DashboardHeader
        title="Contracts"
        subtitle="Commercial agreements between your organization and Familiarise. Programs attach to a contract; billing flows from it."
        actions={
          canCreate && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> New Contract
            </Button>
          )
        }
      />

      <DashboardContent>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {contracts.isLoading
                ? "Loading…"
                : `${contractList.length} contract${contractList.length === 1 ? "" : "s"}`}
            </CardTitle>
            <CardDescription>
              ACTIVE contracts accept new Programs. DRAFT contracts need to be
              activated first. Only DRAFT contracts with no attached Programs
              can be deleted — use TERMINATED to close an active one.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {contracts.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : contractList.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <FileText className="h-10 w-10 mx-auto mb-3 text-muted-foreground/40" />
                <p className="text-sm">No contracts yet.</p>
                {canCreate && (
                  <p className="text-xs mt-2">
                    Click <strong>New Contract</strong> to create one. Programs
                    and invoices attach to a contract.
                  </p>
                )}
              </div>
            ) : (
              <ResponsiveTable<ContractItem>
                columns={columns}
                rows={contractList}
                getRowId={(c) => c.id}
                rowActions={canManage ? renderRowActions : undefined}
              />
            )}
            {actionError && (
              <p className="mt-3 text-sm text-red-600">{actionError}</p>
            )}
          </CardContent>
        </Card>
      </DashboardContent>

      {/* Create dialog */}
      {billingAccountId && (
        <CreateContractDialog
          orgId={orgId}
          billingAccountId={billingAccountId}
          fundingSource={billingAccount.data?.billingAccount.fundingSource}
          open={createOpen}
          onOpenChange={setCreateOpen}
        />
      )}

      {/* Detail drawer */}
      {detailTarget && (
        <ContractDetailDialog
          orgId={orgId}
          contractId={detailTarget.id}
          open={!!detailTarget}
          onOpenChange={(v) => {
            if (!v) setDetailTarget(null);
          }}
        />
      )}

      {/* Edit dialog */}
      {editTarget && (
        <EditContractDialog
          orgId={orgId}
          contractId={editTarget.id}
          open={!!editTarget}
          onOpenChange={(v) => {
            if (!v) setEditTarget(null);
          }}
        />
      )}

      {/* Activate confirmation */}
      <AlertDialog
        open={!!activateTarget}
        onOpenChange={(v) => !v && setActivateTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Activate contract?</AlertDialogTitle>
            <AlertDialogDescription>
              This will move the contract from DRAFT to ACTIVE. Programs can
              be attached immediately. This action writes an audit log entry.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!activateTarget) return;
                patchMutation.mutate({
                  contractId: activateTarget.id,
                  body: {
                    status: "ACTIVE",
                    signedAt: new Date().toISOString(),
                  },
                });
              }}
              disabled={patchMutation.isPending}
            >
              {patchMutation.isPending ? "Activating…" : "Activate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Terminate confirmation */}
      <AlertDialog
        open={!!terminateTarget}
        onOpenChange={(v) => !v && setTerminateTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Terminate contract?</AlertDialogTitle>
            <AlertDialogDescription>
              Terminating an ACTIVE contract is permanent. Programs with live
              assignments must be cancelled before you can terminate — the
              server will reject this if active assignments exist.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                if (!terminateTarget) return;
                patchMutation.mutate({
                  contractId: terminateTarget.id,
                  body: { status: "TERMINATED" },
                });
              }}
              disabled={patchMutation.isPending}
            >
              {patchMutation.isPending ? "Terminating…" : "Terminate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete DRAFT contract?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the contract record. Only possible for
              DRAFT contracts with no attached Programs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                if (!deleteTarget) return;
                deleteMutation.mutate(deleteTarget.id);
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
