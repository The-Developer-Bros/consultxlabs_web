"use client";

import { use, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Briefcase,
  Loader2,
  Users,
  Pencil,
  Lock,
  Trash2,
} from "lucide-react";
import type {
  BillingCycle,
  FundingSource,
  OverageBehavior,
  ProgramStatus,
  ProgramType,
} from "@prisma/client";

import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
import {
  capabilityOf,
  isReachableOrgFundingPath,
  type ReachableCapability,
} from "@/lib/enterprise/reachable-paths";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { Checkbox } from "@/components/ui/checkbox";
// WIP banner import removed — see PR #655 reviewer feedback. The
// credit-pool soak status is tracked in #715/#716 in the issue tracker;
// no in-product banner.
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
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { formatCurrencyAmount } from "@/utils/formatting";

// ---------------------------------------------------------------------------
// Types — shaped to match GET /api/organizations/[orgId]/programs
// ---------------------------------------------------------------------------

interface ProgramListItem {
  id: string;
  contractId: string;
  type: ProgramType;
  name: string;
  status: ProgramStatus;
  coveredPlanTypes: string[];
  allowedCategories: string[];
  createdAt: string;
  licensedSeatConfig: {
    ratePerSeatPaise: number;
    cycle: BillingCycle;
    coveredEngagementsPerCycle: number | null;
    overageBehavior: OverageBehavior;
    overageSurchargeBps: number | null;
    priceCapPerEngagementPaise: number | null;
    maxOveragePerCyclePaise: number | null;
    activeSeatCount: number;
  } | null;
  creditPoolConfig: {
    cycle: BillingCycle;
    creditBudgetPerCycle: number;
    overageBehavior: OverageBehavior;
    overageSurchargeBps: number | null;
    maxOveragePerCyclePaise: number | null;
  } | null;
  _count: { assignments: number };
  // #777 §H — current-cycle usage aggregate across this program's assignments.
  utilization: {
    activeAssignments: number;
    engagementsUsed: number;
    consumedPaise: number;
  };
}

// #777 §H — program-level utilization across current-cycle assignments. Capacity
// is the per-assignment cap × active assignments (engagements for LICENSED_SEAT,
// ₹ budget for CREDIT_POOL). Null = nothing to show (no assignments / unlimited).
function programUtilization(
  p: ProgramListItem,
): { used: string; total: string; pct: number | null } | null {
  const { activeAssignments, engagementsUsed, consumedPaise } = p.utilization;
  if (activeAssignments === 0) return null;
  if (p.type === "LICENSED_SEAT") {
    const cap = p.licensedSeatConfig?.coveredEngagementsPerCycle ?? null;
    if (cap === null)
      return { used: String(engagementsUsed), total: "∞", pct: null };
    const total = cap * activeAssignments;
    return {
      used: String(engagementsUsed),
      total: String(total),
      // ceil, not round (#752) — non-zero usage must never display as 0%.
      pct: total > 0 ? Math.min(100, Math.ceil((engagementsUsed / total) * 100)) : null,
    };
  }
  if (p.type === "CREDIT_POOL") {
    const budgetPaise =
      (p.creditPoolConfig?.creditBudgetPerCycle ?? 0) * 100 * activeAssignments;
    return {
      used: formatCurrencyAmount(consumedPaise, "INR"),
      total: budgetPaise > 0 ? formatCurrencyAmount(budgetPaise, "INR") : "∞",
      pct:
        budgetPaise > 0
          ? Math.min(100, Math.ceil((consumedPaise / budgetPaise) * 100))
          : null,
    };
  }
  return null;
}

// Human labels for the OverageBehavior enum (#777 §H) — the raw enum leaks
// into the list/detail UI otherwise.
const OVERAGE_BEHAVIOR_LABEL: Record<OverageBehavior, string> = {
  BLOCK: "Block",
  CHARGE_MEMBER: "Charge member",
  CHARGE_ORG: "Charge org",
};

interface ContractListItem {
  id: string;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  paymentTermsDays: number;
  billingAccount: { currency: string; fundingSource: string } | null;
  purchaseOrder: { poNumber: string } | null;
}

/**
 * Contracts don't have a user-defined name. Build a concise label from
 * the fields that a founder actually recognises — funding source, PO
 * number if present, and the effective window. The UUID prefix is kept
 * as a last-resort disambiguator (two contracts in the same funding
 * source signed on the same day would otherwise look identical).
 */
function formatContractLabel(c: ContractListItem): string {
  const funding = c.billingAccount?.fundingSource ?? "UNKNOWN";
  const po = c.purchaseOrder?.poNumber;
  const from = new Date(c.effectiveFrom).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const to = c.effectiveTo
    ? new Date(c.effectiveTo).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "open-ended";
  const suffix = po ? `PO ${po}` : `ref ${c.id.slice(0, 6)}`;
  return `${funding} · ${from} → ${to} · ${suffix}`;
}

// ---------------------------------------------------------------------------
// API layer
// ---------------------------------------------------------------------------

async function fetchPrograms(
  orgId: string,
): Promise<{ data: ProgramListItem[] }> {
  const res = await fetch(`/api/organizations/${orgId}/programs`);
  if (!res.ok) throw new Error("Failed to load programs");
  return res.json();
}

async function fetchContracts(
  orgId: string,
): Promise<{ data: ContractListItem[] }> {
  const res = await fetch(
    `/api/organizations/${orgId}/contracts?status=ACTIVE`,
  );
  if (!res.ok) throw new Error("Failed to load contracts");
  return res.json();
}

const COVERED_PLAN_TYPE_OPTIONS = [
  { value: "CONSULTATION", label: "Consultation", description: "1:1 sessions" },
  { value: "CLASS", label: "Class", description: "Group classes" },
  { value: "WEBINAR", label: "Webinar", description: "Live webinars" },
  { value: "SUBSCRIPTION", label: "Subscription", description: "Recurring plans" },
] as const;

type CoveredPlanType = (typeof COVERED_PLAN_TYPE_OPTIONS)[number]["value"];

type CreateProgramBody =
  | {
      type: "LICENSED_SEAT";
      contractId: string;
      name: string;
      coveredPlanTypes: CoveredPlanType[];
      licensedSeatConfig: {
        ratePerSeatPaise: number;
        cycle: BillingCycle;
        coveredEngagementsPerCycle: number | null;
        overageBehavior: OverageBehavior;
        overageSurchargeBps: number | null;
        maxOveragePerCyclePaise: number | null;
      };
    }
  | {
      type: "CREDIT_POOL";
      contractId: string;
      name: string;
      coveredPlanTypes: CoveredPlanType[];
      creditPoolConfig: {
        cycle: BillingCycle;
        creditBudgetPerCycle: number;
        overageBehavior: OverageBehavior;
        overageSurchargeBps: number | null;
        maxOveragePerCyclePaise: number | null;
      };
    };

async function createProgram(orgId: string, body: CreateProgramBody) {
  const res = await fetch(`/api/organizations/${orgId}/programs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (json as { error?: string }).error ?? "Failed to create program",
    );
  }
  return json;
}

// PATCH accepts `name` always; money fields only when the program isn't
// locked (#777 §B). The server is the authority — it re-checks the lock and
// 409s PROGRAM_CONFIG_LOCKED if a money field slips through.
type PatchProgramBody = {
  name?: string;
  coveredPlanTypes?: CoveredPlanType[];
  ratePerSeatPaise?: number;
  coveredEngagementsPerCycle?: number | null;
  creditBudgetPerCycle?: number;
  overageBehavior?: OverageBehavior;
  overageSurchargeBps?: number | null;
  maxOveragePerCyclePaise?: number | null;
};

async function patchProgram(
  orgId: string,
  programId: string,
  body: PatchProgramBody,
) {
  const res = await fetch(`/api/organizations/${orgId}/programs/${programId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (json as { error?: string }).error ?? "Failed to update program",
    );
  }
  return json;
}

// DELETE is only legal for never-used programs (#752) — the server re-checks
// assignments + utilization under Serializable and 409s otherwise; the UI
// gate is affordance, not authority.
async function deleteProgram(orgId: string, programId: string) {
  const res = await fetch(`/api/organizations/${orgId}/programs/${programId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(
      (json as { error?: string }).error ?? "Failed to delete program",
    );
  }
}

// Single-program shape from GET .../programs/[programId] — carries the
// derived `locked` flag the edit dialog uses to disable money fields.
type ProgramDetail = ProgramListItem & { locked: boolean };

async function fetchProgram(
  orgId: string,
  programId: string,
): Promise<{ program: ProgramDetail }> {
  const res = await fetch(`/api/organizations/${orgId}/programs/${programId}`);
  if (!res.ok) throw new Error("Failed to load program");
  return res.json();
}

// ---------------------------------------------------------------------------
// API layer — assignments (#741)
// ---------------------------------------------------------------------------

interface MemberListItem {
  id: string;
  role: string;
  user: { id: string; name: string | null; email: string };
}

interface AssignmentListItem {
  id: string;
  periodStart: string;
  periodEnd: string;
  membership: {
    id: string;
    role: string;
    user: { id: string; name: string | null; email: string };
  };
}

async function fetchMembers(
  orgId: string,
): Promise<{ data: MemberListItem[] }> {
  const res = await fetch(`/api/organizations/${orgId}/members?perPage=100`);
  if (!res.ok) throw new Error("Failed to load members");
  return res.json();
}

async function fetchAssignments(
  orgId: string,
  programId: string,
): Promise<{ data: AssignmentListItem[] }> {
  const res = await fetch(
    `/api/organizations/${orgId}/programs/${programId}/assignments`,
  );
  if (!res.ok) throw new Error("Failed to load assignments");
  return res.json();
}

async function createAssignment(
  orgId: string,
  programId: string,
  body: { membershipId: string; periodStart: string; periodEnd: string },
) {
  const res = await fetch(
    `/api/organizations/${orgId}/programs/${programId}/assignments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (json as { error?: string }).error ?? "Failed to create assignment",
    );
  }
  return json;
}

// ---------------------------------------------------------------------------
// Create-program dialog
// ---------------------------------------------------------------------------

const PROGRAM_TYPE_META: Record<
  ProgramType,
  { label: string; description: string; available: boolean }
> = {
  LICENSED_SEAT: {
    label: "Licensed seat",
    description:
      "Per-seat licence. Each seat covers N engagements (calendar occurrences) per cycle, or unlimited.",
    available: true,
  },
  CREDIT_POOL: {
    label: "Credit pool",
    description:
      "Pool with a per-cycle credit cap (1 credit = ₹1). Each booking debits credits from the org wallet up to the cap.",
    available: true,
  },
};

const BILLING_CYCLES: BillingCycle[] = ["MONTHLY", "QUARTERLY", "ANNUAL"];

// Money inputs take rupees (major units) for typing ergonomics. Paise
// conversion happens at submit time so the DB always stores paise
// (consistent with the rest of the enterprise schema).
function rupeesToPaise(rupees: string): number | null {
  const trimmed = rupees.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function CreateProgramDialog({
  orgId,
  open,
  onOpenChange,
  contracts,
  capability,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contracts: ContractListItem[];
  // Derived from canSponsor/canHost (#768) — the program-type picker only
  // offers types reachable for (capability, selected contract funding).
  capability: ReachableCapability | null;
}) {
  const queryClient = useQueryClient();
  const [programType, setProgramType] = useState<"LICENSED_SEAT" | "CREDIT_POOL">(
    "LICENSED_SEAT",
  );
  const [contractId, setContractId] = useState<string>("");
  const [name, setName] = useState("");
  const [ratePerSeatRupees, setRatePerSeatRupees] = useState("5000");
  const [cycle, setCycle] = useState<BillingCycle>("MONTHLY");
  const [coveredEngagementsPerCycle, setCoveredEngagementsPerCycle] = useState("");
  const [overageBehavior, setOverageBehavior] =
    useState<OverageBehavior>("BLOCK");
  // #775 — optional markup on over-cap bookings, entered as a percentage and
  // stored as bps (10% → 1000 bps). Blank = no markup. Shared across both
  // program types (the selector + this field render for LICENSED_SEAT and
  // CREDIT_POOL alike).
  const [overageSurchargePct, setOverageSurchargePct] = useState("");
  // #768 #14/#15 — per-cycle overage ceiling in rupees (user-facing).
  // Server requires positive paise value whenever overageBehavior !== BLOCK;
  // shared across both program types.
  const [maxOveragePerCycleRupees, setMaxOveragePerCycleRupees] = useState("");
  // 1 credit = ₹1; per-cycle cap is the user-facing input, paise conversion
  // is implicit (credits map to rupees end-to-end).
  const [creditBudgetPerCycle, setCreditsPerCycle] = useState("1000");
  const [coveredPlanTypes, setCoveredPlanTypes] = useState<CoveredPlanType[]>(["CONSULTATION"]);
  const [error, setError] = useState<string | null>(null);

  // The selected contract's funding source decides which program types are
  // reachable (#768). Until a contract is picked we offer nothing — the user
  // must choose the funding context first, mirroring the server gate.
  const selectedFunding = useMemo<FundingSource | null>(() => {
    const raw = contracts.find((c) => c.id === contractId)?.billingAccount
      ?.fundingSource;
    return raw === "PERSONAL" ||
      raw === "WALLET" ||
      raw === "INVOICE" ||
      raw === "LICENSE"
      ? raw
      : null;
  }, [contracts, contractId]);

  const reachableTypes = useMemo<Array<"LICENSED_SEAT" | "CREDIT_POOL">>(() => {
    if (!capability) return [];
    return (["LICENSED_SEAT", "CREDIT_POOL"] as const).filter((t) =>
      isReachableOrgFundingPath(capability, selectedFunding, t),
    );
  }, [capability, selectedFunding]);

  // Auto-correct an unreachable selection when the funding context changes
  // (e.g. user switches from an INVOICE to a LICENSE contract while
  // CREDIT_POOL is selected). Keeps the form submittable without surfacing a
  // server rejection the UI could have prevented.
  useEffect(() => {
    if (reachableTypes.length > 0 && !reachableTypes.includes(programType)) {
      setProgramType(reachableTypes[0]);
    }
  }, [reachableTypes, programType]);

  const reset = () => {
    setProgramType("LICENSED_SEAT");
    setContractId("");
    setName("");
    setRatePerSeatRupees("5000");
    setCycle("MONTHLY");
    setCoveredEngagementsPerCycle("");
    setOverageBehavior("BLOCK");
    setOverageSurchargePct("");
    setMaxOveragePerCycleRupees("");
    setCreditsPerCycle("1000");
    setCoveredPlanTypes(["CONSULTATION"]);
    setError(null);
  };

  const createMutation = useMutation({
    mutationFn: (body: CreateProgramBody) => createProgram(orgId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-programs", orgId] });
      reset();
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = () => {
    setError(null);
    if (!contractId) {
      setError("Pick the contract this program attaches to.");
      return;
    }
    // Mirror the server's UNREACHABLE_FUNDING_PATH gate (#768) so a stale
    // selection can't slip past into a guaranteed 400.
    if (!reachableTypes.includes(programType)) {
      setError(
        `${PROGRAM_TYPE_META[programType].label} programs aren't available for this contract's funding source.`,
      );
      return;
    }
    if (name.trim().length < 2) {
      setError("Program name must be at least 2 characters.");
      return;
    }
    if (coveredPlanTypes.length === 0) {
      setError("Select at least one appointment type this program covers.");
      return;
    }
    // #775 — percentage → bps (10% → 1000). Blank = no markup. Applies to both
    // program types; only meaningful when overageBehavior charges (not BLOCK).
    const surchargeBps =
      overageSurchargePct.trim() === ""
        ? null
        : Math.round(parseFloat(overageSurchargePct) * 100);
    if (
      surchargeBps !== null &&
      (!Number.isFinite(surchargeBps) || surchargeBps < 0)
    ) {
      setError("Overage surcharge must be blank or a non-negative percentage.");
      return;
    }
    // #768 #14/#15 — per-cycle ceiling. Required (>=1 paise) for CHARGE_*,
    // ignored otherwise. Mirror the server's refineOverageCombo so the form
    // can't submit a 400 the user would only see as "Invalid body".
    //
    // LICENSED_SEAT with unlimited cap (coveredEngagementsPerCycle blank/null)
    // makes every overage knob dead config — the server's
    // LicensedSeatConfigSchema.superRefine rejects overageBehavior != BLOCK
    // (and any non-null circuit-breaker) in that case. Block it here too so
    // the operator gets a single clear message instead of the opaque 400.
    let maxOveragePerCyclePaise: number | null = null;
    if (overageBehavior !== "BLOCK") {
      if (
        programType === "LICENSED_SEAT" &&
        coveredEngagementsPerCycle.trim() === ""
      ) {
        setError(
          "Overage settings have no effect when sessions per cycle is unlimited. Either enter a positive cap or switch overage behaviour to Block.",
        );
        return;
      }
      const parsed = rupeesToPaise(maxOveragePerCycleRupees);
      if (parsed === null || parsed < 1) {
        setError(
          "Max overage per cycle is required when overage charges the org/member — enter a positive rupee ceiling.",
        );
        return;
      }
      maxOveragePerCyclePaise = parsed;
    }
    if (programType === "LICENSED_SEAT") {
      const ratePaise = rupeesToPaise(ratePerSeatRupees);
      if (ratePaise === null) {
        setError("Rate per seat must be a non-negative number (in rupees).");
        return;
      }
      const cap =
        coveredEngagementsPerCycle.trim() === ""
          ? null
          : parseInt(coveredEngagementsPerCycle, 10);
      if (cap !== null && (!Number.isFinite(cap) || cap < 1)) {
        setError("Covered engagements per cycle must be blank or a positive integer.");
        return;
      }
      createMutation.mutate({
        type: "LICENSED_SEAT",
        contractId,
        name: name.trim(),
        coveredPlanTypes,
        licensedSeatConfig: {
          ratePerSeatPaise: ratePaise,
          cycle,
          coveredEngagementsPerCycle: cap,
          overageBehavior,
          overageSurchargeBps: surchargeBps,
          maxOveragePerCyclePaise,
        },
      });
    } else {
      const credits = Number(creditBudgetPerCycle.trim());
      if (!Number.isFinite(credits) || credits < 1 || !Number.isInteger(credits)) {
        setError("Credits per cycle must be a positive integer.");
        return;
      }
      createMutation.mutate({
        type: "CREDIT_POOL",
        contractId,
        name: name.trim(),
        coveredPlanTypes,
        creditPoolConfig: {
          cycle,
          creditBudgetPerCycle: credits,
          overageBehavior,
          overageSurchargeBps: surchargeBps,
          maxOveragePerCyclePaise,
        },
      });
    }
  };

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <ResponsiveModalContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Create Program</ResponsiveModalTitle>
        </ResponsiveModalHeader>

        <div className="space-y-5">
          {/* Program type */}
          <div className="space-y-2">
            <Label>Program type</Label>
            <Select
              value={programType}
              onValueChange={(v) => {
                if (v === "LICENSED_SEAT" || v === "CREDIT_POOL") {
                  setProgramType(v);
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["LICENSED_SEAT", "CREDIT_POOL"] as const).map((t) => {
                  // Disable rather than omit so the absent option is
                  // explained in place — e.g. CREDIT_POOL under a LICENSE
                  // contract reads as unavailable, not missing (#768).
                  const reachable = reachableTypes.includes(t);
                  return (
                    <SelectItem key={t} value={t} disabled={!reachable}>
                      {PROGRAM_TYPE_META[t].label}
                      {!reachable && " — not available for this contract"}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <p className="text-xs text-zinc-500">
              {contractId
                ? PROGRAM_TYPE_META[programType].description
                : "Pick a contract first — the program types below depend on its funding source."}
            </p>
          </div>

          {/* Contract */}
          <div className="space-y-2">
            <Label>Contract</Label>
            <Select value={contractId} onValueChange={setContractId}>
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    contracts.length === 0
                      ? "No ACTIVE contracts — create one first"
                      : "Pick a contract"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {contracts.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {formatContractLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-zinc-500">
              The program inherits the contract&apos;s billing account and
              currency. Rates below are in ₹ (rupees).
            </p>
          </div>

          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="program-name">Name</Label>
            <Input
              id="program-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Q1 Leadership Coaching"
            />
          </div>

          {/* Covered plan types (#740) */}
          <div className="space-y-2">
            <Label>Covered appointment types</Label>
            <div className="grid grid-cols-2 gap-2">
              {COVERED_PLAN_TYPE_OPTIONS.map((opt) => {
                const checked = coveredPlanTypes.includes(opt.value);
                return (
                  <label
                    key={opt.value}
                    className="flex items-start gap-2 rounded-md border p-2.5 cursor-pointer hover:bg-zinc-50 transition-colors"
                  >
                    <Checkbox
                      id={`plan-type-${opt.value}`}
                      checked={checked}
                      onCheckedChange={(v) => {
                        setCoveredPlanTypes((prev) =>
                          v
                            ? [...prev, opt.value]
                            : prev.filter((t) => t !== opt.value),
                        );
                      }}
                      className="mt-0.5"
                    />
                    <div>
                      <span className="text-sm font-medium">{opt.label}</span>
                      <p className="text-xs text-zinc-500">{opt.description}</p>
                    </div>
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-zinc-500">
              Only bookings matching a selected type will be covered by this
              program. Select at least one.
            </p>
          </div>

          {programType === "LICENSED_SEAT" ? (
            <>
              {/* Rate + cycle — row 1 */}
              <div className="grid grid-cols-[1fr_180px] gap-3">
                <div className="space-y-2">
                  <Label htmlFor="rate-per-seat">Rate per seat (₹)</Label>
                  <Input
                    id="rate-per-seat"
                    type="number"
                    min={0}
                    step={1}
                    value={ratePerSeatRupees}
                    onChange={(e) => setRatePerSeatRupees(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Cycle</Label>
                  <Select
                    value={cycle}
                    onValueChange={(v) => {
                      if (
                        v === "MONTHLY" ||
                        v === "QUARTERLY" ||
                        v === "ANNUAL"
                      ) {
                        setCycle(v);
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BILLING_CYCLES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Engagements per cycle — full width so the hint + input
                  breathe instead of wrapping into a 2-col cell. */}
              <div className="space-y-2">
                <Label htmlFor="covered-engagements">
                  Engagements per cycle
                </Label>
                <Input
                  id="covered-engagements"
                  type="number"
                  min={1}
                  value={coveredEngagementsPerCycle}
                  onChange={(e) =>
                    setCoveredEngagementsPerCycle(e.target.value)
                  }
                  placeholder="e.g. 12 — leave blank for unlimited"
                />
                <p className="text-xs text-zinc-500">
                  An engagement is one calendar occurrence — a 1:1 call, a
                  webinar, or one class day. A 4-hour mentoring call counts
                  as 1; a 12-call subscription counts as 12 over the cycle;
                  an 8-week class counts as 8. Per-engagement price cap is
                  separate. Leave blank for unlimited (flat licence).
                </p>
              </div>

            </>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="credits-per-cycle">
                Credits per cycle (1 credit = ₹1)
              </Label>
              <Input
                id="credits-per-cycle"
                type="number"
                min={1}
                step={1}
                value={creditBudgetPerCycle}
                onChange={(e) => setCreditsPerCycle(e.target.value)}
              />
              <p className="text-xs text-zinc-500">
                Hard cap on bookings per {cycle.toLowerCase()} cycle. Each
                credit equals ₹1; debits stop at the cap unless overage is
                enabled.
              </p>
              {/* Credit-pool refund/invoice round-trip soak is tracked in
                  #715 + #716. Per PR #655 reviewer feedback, this is no
                  longer surfaced as a WIP banner — the feature is shipped
                  (schema, lazy debit, reconcile cron all wired) and the
                  remaining acceptance work is operator-visible only via
                  the regular issue tracker. */}
            </div>
          )}

          {/* Overage policy — shared across both program types (#775). The
              org owner's "who bears the over-cap cost" toggle: BLOCK /
              member-funded / org-billed. All three ship end-to-end. */}
          <div className="space-y-2">
            <Label>Overage behaviour</Label>
            <Select
              value={overageBehavior}
              onValueChange={(v) => {
                if (
                  v === "BLOCK" ||
                  v === "CHARGE_MEMBER" ||
                  v === "CHARGE_ORG"
                ) {
                  setOverageBehavior(v);
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="BLOCK">
                  Block — reject booking once the cap is hit
                </SelectItem>
                <SelectItem value="CHARGE_MEMBER">
                  Charge member — learner pays the overage on their own card
                </SelectItem>
                <SelectItem value="CHARGE_ORG">
                  Charge org — added to the next invoice
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-zinc-500">
              Applies to <strong>new</strong> bookings from the moment you
              save — existing overage charges keep the policy they were booked
              under. Switching to Block stops further over-cap bookings
              immediately.
            </p>
          </div>

          {/* Overage surcharge — only meaningful when bookings can overage. */}
          {overageBehavior !== "BLOCK" && (
            <div className="space-y-2">
              <Label htmlFor="overage-surcharge">Overage surcharge (%)</Label>
              <Input
                id="overage-surcharge"
                type="number"
                min={0}
                step="0.01"
                value={overageSurchargePct}
                onChange={(e) => setOverageSurchargePct(e.target.value)}
                placeholder="e.g. 10 — leave blank for no markup"
              />
              <p className="text-xs text-zinc-500">
                Optional markup on the over-cap amount (the real session price
                passes through; consulting rates are heterogeneous, so this is
                a percentage knob rather than a flat per-unit tier). Blank = no
                markup.
              </p>
            </div>
          )}

          {/* #768 #14/#15 — per-cycle overage ceiling (circuit breaker).
              Server requires a positive value when overage charges. */}
          {overageBehavior !== "BLOCK" && (
            <div className="space-y-2">
              <Label htmlFor="max-overage">Max overage per cycle (₹)</Label>
              <Input
                id="max-overage"
                type="number"
                min={1}
                step="1"
                value={maxOveragePerCycleRupees}
                onChange={(e) => setMaxOveragePerCycleRupees(e.target.value)}
                placeholder="e.g. 100000 = ₹1,00,000 ceiling"
              />
              <p className="text-xs text-zinc-500">
                Hard cap on the total over-cap amount this cycle (circuit
                breaker). Once reached, further over-cap bookings are blocked
                even with {overageBehavior === "CHARGE_ORG" ? "Charge org" : "Charge member"} enabled.
                Required by the platform — keeps runaway overage liability bounded.
              </p>
            </div>
          )}

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
// Edit-program dialog (#777 §B) — name editable always; money config goes
// read-only once the program is in use. The lock is server-derived (returned
// on the single-program GET) so the disabled state can't drift from the gate.
// ---------------------------------------------------------------------------

function LockedHint() {
  return (
    <span className="ml-2 inline-flex items-center gap-1 text-xs text-amber-600">
      <Lock className="h-3 w-3" /> Locked — in use
    </span>
  );
}

function EditProgramDialog({
  orgId,
  programId,
  open,
  onOpenChange,
}: {
  orgId: string;
  programId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["org-program", orgId, programId],
    queryFn: () => fetchProgram(orgId, programId),
    enabled: open,
  });
  const program = detail.data?.program;
  const locked = program?.locked ?? true; // fail-safe: lock until we know

  const [name, setName] = useState("");
  const [coveredPlanTypes, setCoveredPlanTypes] = useState<CoveredPlanType[]>(
    [],
  );
  const [ratePerSeatRupees, setRatePerSeatRupees] = useState("");
  const [coveredEngagementsPerCycle, setCoveredEngagementsPerCycle] =
    useState("");
  const [creditBudgetPerCycle, setCreditsPerCycle] = useState("");
  const [overageBehavior, setOverageBehavior] =
    useState<OverageBehavior>("BLOCK");
  const [overageSurchargePct, setOverageSurchargePct] = useState("");
  // #768 #14/#15 — circuit-breaker ceiling, parity with CreateProgramDialog.
  const [maxOveragePerCycleRupees, setMaxOveragePerCycleRupees] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Seed the form from the fetched program once it lands (and on re-open).
  useEffect(() => {
    if (!program) return;
    setName(program.name);
    setCoveredPlanTypes(program.coveredPlanTypes as CoveredPlanType[]);
    setOverageBehavior(
      program.licensedSeatConfig?.overageBehavior ??
        program.creditPoolConfig?.overageBehavior ??
        "BLOCK",
    );
    const bps =
      program.licensedSeatConfig?.overageSurchargeBps ??
      program.creditPoolConfig?.overageSurchargeBps ??
      null;
    setOverageSurchargePct(bps === null ? "" : String(bps / 100));
    const maxOverage =
      program.licensedSeatConfig?.maxOveragePerCyclePaise ??
      program.creditPoolConfig?.maxOveragePerCyclePaise ??
      null;
    setMaxOveragePerCycleRupees(
      maxOverage === null ? "" : String(maxOverage / 100),
    );
    if (program.licensedSeatConfig) {
      setRatePerSeatRupees(
        String(program.licensedSeatConfig.ratePerSeatPaise / 100),
      );
      setCoveredEngagementsPerCycle(
        program.licensedSeatConfig.coveredEngagementsPerCycle === null
          ? ""
          : String(program.licensedSeatConfig.coveredEngagementsPerCycle),
      );
    }
    if (program.creditPoolConfig) {
      setCreditsPerCycle(String(program.creditPoolConfig.creditBudgetPerCycle));
    }
    setError(null);
  }, [program]);

  const patchMutation = useMutation({
    mutationFn: (body: PatchProgramBody) =>
      patchProgram(orgId, programId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-programs", orgId] });
      queryClient.invalidateQueries({
        queryKey: ["org-program", orgId, programId],
      });
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = () => {
    setError(null);
    if (name.trim().length < 2) {
      setError("Program name must be at least 2 characters.");
      return;
    }
    // name is the only field that's always safe to send. When the program is
    // locked we send name alone; the server rejects any money field anyway.
    const body: PatchProgramBody = { name: name.trim() };
    if (!locked && program) {
      if (coveredPlanTypes.length === 0) {
        setError("Select at least one appointment type this program covers.");
        return;
      }
      body.coveredPlanTypes = coveredPlanTypes;
      const surchargeBps =
        overageSurchargePct.trim() === ""
          ? null
          : Math.round(parseFloat(overageSurchargePct) * 100);
      if (
        surchargeBps !== null &&
        (!Number.isFinite(surchargeBps) || surchargeBps < 0)
      ) {
        setError("Overage surcharge must be blank or a non-negative percentage.");
        return;
      }
      body.overageBehavior = overageBehavior;
      body.overageSurchargeBps = surchargeBps;
      // #768 #14/#15 — circuit-breaker ceiling. PATCH validation at
      // [programId]/route.ts:225-239 merges with the existing config and
      // requires the merged value to be positive when overage charges. We
      // ALWAYS send the field (null when blank or overage=BLOCK) so the merge
      // sees the user's intent and not a stale config row.
      //
      // LICENSED_SEAT with unlimited cap (coveredEngagementsPerCycle blank)
      // makes every overage knob dead config — the server's
      // LicensedSeatConfigSchema.superRefine rejects overageBehavior != BLOCK
      // (and any non-null circuit-breaker) in that case. Block it here too so
      // the operator gets a single clear message instead of the opaque 400.
      let maxOveragePerCyclePaise: number | null = null;
      if (overageBehavior !== "BLOCK") {
        if (
          program.type === "LICENSED_SEAT" &&
          coveredEngagementsPerCycle.trim() === ""
        ) {
          setError(
            "Overage settings have no effect when sessions per cycle is unlimited. Either enter a positive cap or switch overage behaviour to Block.",
          );
          return;
        }
        const parsed = rupeesToPaise(maxOveragePerCycleRupees);
        if (parsed === null || parsed < 1) {
          setError(
            "Max overage per cycle is required when overage charges the org/member — enter a positive rupee ceiling.",
          );
          return;
        }
        maxOveragePerCyclePaise = parsed;
      }
      body.maxOveragePerCyclePaise = maxOveragePerCyclePaise;
      if (program.type === "LICENSED_SEAT") {
        const ratePaise = rupeesToPaise(ratePerSeatRupees);
        if (ratePaise === null) {
          setError("Rate per seat must be a non-negative number (in rupees).");
          return;
        }
        const cap =
          coveredEngagementsPerCycle.trim() === ""
            ? null
            : parseInt(coveredEngagementsPerCycle, 10);
        if (cap !== null && (!Number.isFinite(cap) || cap < 1)) {
          setError(
            "Covered engagements per cycle must be blank or a positive integer.",
          );
          return;
        }
        body.ratePerSeatPaise = ratePaise;
        body.coveredEngagementsPerCycle = cap;
      } else {
        const credits = Number(creditBudgetPerCycle.trim());
        if (
          !Number.isFinite(credits) ||
          credits < 1 ||
          !Number.isInteger(credits)
        ) {
          setError("Credits per cycle must be a positive integer.");
          return;
        }
        body.creditBudgetPerCycle = credits;
      }
    }
    patchMutation.mutate(body);
  };

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Edit Program</ResponsiveModalTitle>
        </ResponsiveModalHeader>

        {detail.isLoading || !program ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-5">
            {locked && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                This program is in use (assignments or bookings exist). Its
                money config is locked — only the name can be changed. Rate
                changes that apply from the next cycle are tracked in #779.
              </p>
            )}

            {/* Name — always editable */}
            <div className="space-y-2">
              <Label htmlFor="edit-program-name">Name</Label>
              <Input
                id="edit-program-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            {/* Type is immutable post-create — shown read-only for context. */}
            <div className="space-y-2">
              <Label>
                Program type
                {locked && <LockedHint />}
              </Label>
              <p className="text-sm">{PROGRAM_TYPE_META[program.type].label}</p>
            </div>

            {/* Covered plan types (#740) — money config */}
            <div className="space-y-2">
              <Label>
                Covered appointment types
                {locked && <LockedHint />}
              </Label>
              <div className="grid grid-cols-2 gap-2">
                {COVERED_PLAN_TYPE_OPTIONS.map((opt) => {
                  const checked = coveredPlanTypes.includes(opt.value);
                  return (
                    <label
                      key={opt.value}
                      className={`flex items-start gap-2 rounded-md border p-2.5 transition-colors ${
                        locked
                          ? "opacity-60"
                          : "cursor-pointer hover:bg-zinc-50"
                      }`}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={locked}
                        onCheckedChange={(v) => {
                          setCoveredPlanTypes((prev) =>
                            v
                              ? [...prev, opt.value]
                              : prev.filter((t) => t !== opt.value),
                          );
                        }}
                        className="mt-0.5"
                      />
                      <div>
                        <span className="text-sm font-medium">{opt.label}</span>
                        <p className="text-xs text-zinc-500">
                          {opt.description}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            {program.type === "LICENSED_SEAT" ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="edit-rate-per-seat">
                    Rate per seat (₹)
                    {locked && <LockedHint />}
                  </Label>
                  <Input
                    id="edit-rate-per-seat"
                    type="number"
                    min={0}
                    step={1}
                    disabled={locked}
                    value={ratePerSeatRupees}
                    onChange={(e) => setRatePerSeatRupees(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-covered-engagements">
                    Engagements per cycle
                    {locked && <LockedHint />}
                  </Label>
                  <Input
                    id="edit-covered-engagements"
                    type="number"
                    min={1}
                    disabled={locked}
                    value={coveredEngagementsPerCycle}
                    onChange={(e) =>
                      setCoveredEngagementsPerCycle(e.target.value)
                    }
                    placeholder="leave blank for unlimited"
                  />
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="edit-credits-per-cycle">
                  Credits per cycle (1 credit = ₹1)
                  {locked && <LockedHint />}
                </Label>
                <Input
                  id="edit-credits-per-cycle"
                  type="number"
                  min={1}
                  step={1}
                  disabled={locked}
                  value={creditBudgetPerCycle}
                  onChange={(e) => setCreditsPerCycle(e.target.value)}
                />
              </div>
            )}

            {/* Overage policy — money config */}
            <div className="space-y-2">
              <Label>
                Overage behaviour
                {locked && <LockedHint />}
              </Label>
              <Select
                value={overageBehavior}
                disabled={locked}
                onValueChange={(v) => {
                  if (
                    v === "BLOCK" ||
                    v === "CHARGE_MEMBER" ||
                    v === "CHARGE_ORG"
                  ) {
                    setOverageBehavior(v);
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="BLOCK">
                    Block — reject booking once the cap is hit
                  </SelectItem>
                  <SelectItem value="CHARGE_MEMBER">
                    Charge member — learner pays the overage on their own card
                  </SelectItem>
                  <SelectItem value="CHARGE_ORG">
                    Charge org — added to the next invoice
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {overageBehavior !== "BLOCK" && (
              <div className="space-y-2">
                <Label htmlFor="edit-overage-surcharge">
                  Overage surcharge (%)
                  {locked && <LockedHint />}
                </Label>
                <Input
                  id="edit-overage-surcharge"
                  type="number"
                  min={0}
                  step="0.01"
                  disabled={locked}
                  value={overageSurchargePct}
                  onChange={(e) => setOverageSurchargePct(e.target.value)}
                  placeholder="leave blank for no markup"
                />
              </div>
            )}

            {/* #768 #14/#15 — per-cycle overage ceiling (circuit breaker).
                Field is in LOCKED_PROGRAM_FIELDS (02-programs.md §4) — read-only
                once the program has any assignments. */}
            {overageBehavior !== "BLOCK" && (
              <div className="space-y-2">
                <Label htmlFor="edit-max-overage">
                  Max overage per cycle (₹)
                  {locked && <LockedHint />}
                </Label>
                <Input
                  id="edit-max-overage"
                  type="number"
                  min={1}
                  step="1"
                  disabled={locked}
                  value={maxOveragePerCycleRupees}
                  onChange={(e) =>
                    setMaxOveragePerCycleRupees(e.target.value)
                  }
                  placeholder="e.g. 100000 = ₹1,00,000 ceiling"
                />
                <p className="text-xs text-zinc-500">
                  Hard cap on total over-cap spend this cycle. Required when
                  overage charges — caps runaway liability at a known ceiling.
                </p>
              </div>
            )}

            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        )}

        <ResponsiveModalFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={patchMutation.isPending || detail.isLoading || !program}
          >
            {patchMutation.isPending ? (
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
// Manage-program dialog with assign learner (#741)
// ---------------------------------------------------------------------------

function ManageProgramDialog({
  orgId,
  program,
  open,
  onOpenChange,
}: {
  orgId: string;
  program: ProgramListItem;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [membershipId, setMembershipId] = useState("");
  const [periodStart, setPeriodStart] = useState(
    () => new Date().toLocaleDateString("en-CA"),
  );
  const [periodEnd, setPeriodEnd] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return d.toLocaleDateString("en-CA");
  });
  const [assignError, setAssignError] = useState<string | null>(null);

  const members = useQuery({
    queryKey: ["org-members", orgId],
    queryFn: () => fetchMembers(orgId),
    enabled: open,
  });

  const assignments = useQuery({
    queryKey: ["program-assignments", orgId, program.id],
    queryFn: () => fetchAssignments(orgId, program.id),
    enabled: open,
  });

  const assignMutation = useMutation({
    mutationFn: (body: {
      membershipId: string;
      periodStart: string;
      periodEnd: string;
    }) => createAssignment(orgId, program.id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["program-assignments", orgId, program.id],
      });
      queryClient.invalidateQueries({ queryKey: ["org-programs", orgId] });
      setMembershipId("");
      setAssignError(null);
    },
    onError: (err: Error) => setAssignError(err.message),
  });

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteMutation = useMutation({
    mutationFn: () => deleteProgram(orgId, program.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-programs", orgId] });
      setConfirmDelete(false);
      onOpenChange(false);
    },
    onError: (err: Error) => {
      setConfirmDelete(false);
      setDeleteError(err.message);
    },
  });

  const handleAssign = () => {
    setAssignError(null);
    if (!membershipId) {
      setAssignError("Select a member to assign.");
      return;
    }
    if (!periodStart || !periodEnd) {
      setAssignError("Both period start and end dates are required.");
      return;
    }
    if (new Date(periodEnd) <= new Date(periodStart)) {
      setAssignError("Period end must be after period start.");
      return;
    }
    assignMutation.mutate({ membershipId, periodStart, periodEnd });
  };

  const memberList = members.data?.data ?? [];
  const assignmentList = assignments.data?.data ?? [];
  // Filter to LEARNER role members for assignment (the primary use case),
  // but also include MANAGER and MAINTAINER since they can self-test.
  const assignableMembers = memberList.filter(
    (m) => ["LEARNER", "MANAGER", "MAINTAINER", "OWNER"].includes(m.role),
  );

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Manage Program — {program.name}</ResponsiveModalTitle>
        </ResponsiveModalHeader>

        {/* Program info summary */}
        <div className="rounded-md border p-3 space-y-1 text-sm">
          <div className="flex gap-2 flex-wrap">
            <Badge variant="secondary">
              {PROGRAM_TYPE_META[program.type].label}
            </Badge>
            <Badge
              variant="outline"
              className={
                program.status === "ACTIVE"
                  ? "border-green-300 text-green-800"
                  : program.status === "PAUSED"
                    ? "border-amber-300 text-amber-800"
                    : "border-zinc-300 text-zinc-600"
              }
            >
              {program.status}
            </Badge>
          </div>
          {program.coveredPlanTypes.length > 0 && (
            <p className="text-xs text-zinc-500">
              Covers:{" "}
              {program.coveredPlanTypes
                .map((t) => t.charAt(0) + t.slice(1).toLowerCase())
                .join(", ")}
            </p>
          )}
        </div>

        {/* Assign learner form */}
        {program.status === "ACTIVE" && (
          <div className="space-y-3 rounded-md border p-4">
            <h4 className="text-sm font-semibold flex items-center gap-1.5">
              <Users className="h-4 w-4" /> Assign a member
            </h4>
            <div className="space-y-2">
              <Label>Member</Label>
              <Select value={membershipId} onValueChange={setMembershipId}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      members.isLoading
                        ? "Loading members…"
                        : members.isError
                          ? "Failed to load members"
                          : assignableMembers.length === 0
                            ? "No assignable members"
                            : "Pick a member"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {assignableMembers.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.user.name ?? m.user.email} ({m.role})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="period-start">Period start</Label>
                <Input
                  id="period-start"
                  type="date"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="period-end">Period end</Label>
                <Input
                  id="period-end"
                  type="date"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                />
              </div>
            </div>
            {assignError && (
              <p className="text-sm text-red-600">{assignError}</p>
            )}
            <Button
              size="sm"
              onClick={handleAssign}
              disabled={assignMutation.isPending}
            >
              {assignMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-1" /> Assigning…
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4 mr-1" /> Assign
                </>
              )}
            </Button>
          </div>
        )}

        {/* Current assignments list */}
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">
            Assignments ({assignmentList.length})
          </h4>
          {assignments.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : assignmentList.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No members assigned yet. Use the form above to assign a learner.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assignmentList.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="text-sm">
                      {a.membership.user.name ?? a.membership.user.email}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-xs">
                        {a.membership.role}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-zinc-600">
                      {new Date(a.periodStart).toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        timeZone: "UTC",
                      })}
                      {" → "}
                      {new Date(a.periodEnd).toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                        timeZone: "UTC",
                      })}
                    </TableCell>
                    <TableCell>
                      {(() => {
                        const now = Date.now();
                        const start = new Date(a.periodStart).getTime();
                        const end = new Date(a.periodEnd).getTime();
                        if (end < now)
                          return <Badge variant="outline" className="text-xs border-zinc-300 text-zinc-500">Expired</Badge>;
                        if (start > now)
                          return <Badge variant="outline" className="text-xs border-blue-300 text-blue-700">Upcoming</Badge>;
                        return <Badge variant="outline" className="text-xs border-green-300 text-green-700">Active</Badge>;
                      })()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {/* #752 — never-used programs (typo'd cap, wrong contract) are
            deletable; anything with assignments stays terminate-only.
            isSuccess (not !isLoading): a failed assignments read must not
            expose the CTA on an unverified zero. */}
        {assignments.isSuccess && assignmentList.length === 0 && (
          <div className="space-y-2 rounded-md border border-red-200 p-4">
            <h4 className="text-sm font-semibold text-red-700">
              Delete program
            </h4>
            <p className="text-xs text-zinc-500">
              This program has no assignments. If it was created by mistake,
              delete it instead of leaving a terminated row behind. Programs
              with assignments or booking history can only be paused or
              cancelled.
            </p>
            {deleteError && <p className="text-sm text-red-600">{deleteError}</p>}
            <Button
              size="sm"
              variant="outline"
              className="border-red-300 text-red-700 hover:bg-red-50"
              onClick={() => setConfirmDelete(true)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-1" /> Deleting…
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 mr-1" /> Delete program
                </>
              )}
            </Button>
          </div>
        )}

        <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete program?</AlertDialogTitle>
              <AlertDialogDescription>
                Permanently delete{" "}
                <span className="font-medium">{program.name}</span>? This is
                only possible because no members were ever assigned. The
                deletion is recorded in the audit log.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-red-600 hover:bg-red-700 text-white"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? "Deleting…" : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OrgProgramsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const { isAtLeast, canSponsor, canHost } = useOrgRole(orgId);
  const capability = capabilityOf(canSponsor, canHost);
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "programs.manage",
    canSponsor: true,
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [managingProgram, setManagingProgram] = useState<ProgramListItem | null>(
    null,
  );
  const [editingProgram, setEditingProgram] = useState<ProgramListItem | null>(
    null,
  );

  const programs = useQuery({
    queryKey: ["org-programs", orgId],
    queryFn: () => fetchPrograms(orgId),
    enabled: allowed,
  });

  const contracts = useQuery({
    queryKey: ["org-contracts-active", orgId],
    queryFn: () => fetchContracts(orgId),
    enabled: allowed && isAtLeast("MAINTAINER"),
  });

  if (!allowed) return null;

  const programList = programs.data?.data ?? [];
  const contractList = contracts.data?.data ?? [];

  return (
    <>
      <DashboardHeader
        title="Programs"
        subtitle="Typed commercial offerings attached to a Contract. Each Program controls what's covered per assigned member."
        actions={
          isAtLeast("MAINTAINER") && (
            <Button
              size="sm"
              onClick={() => setDialogOpen(true)}
              disabled={contractList.length === 0}
              title={
                contractList.length === 0
                  ? "Create an ACTIVE contract before attaching a Program."
                  : undefined
              }
            >
              <Plus className="h-4 w-4 mr-1" /> New Program
            </Button>
          )
        }
      />
      <DashboardContent>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {programs.isLoading
                ? "Loading…"
                : `${programList.length} program${programList.length === 1 ? "" : "s"}`}
            </CardTitle>
            <CardDescription>
              Active programs show their seat / credit config, current
              assignment count, and attached contract. Per-member assignments
              live inside each program — click <em>View</em> to manage them.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {programs.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : programList.length === 0 ? (
              <div className="text-center py-12 text-zinc-500">
                <Briefcase className="h-10 w-10 mx-auto mb-3 text-zinc-300" />
                <p className="text-sm">No programs yet.</p>
                {isAtLeast("MAINTAINER") && contractList.length > 0 && (
                  <p className="text-xs mt-2">
                    Click <strong>New Program</strong> to create one against an
                    active contract.
                  </p>
                )}
                {contractList.length === 0 && isAtLeast("MAINTAINER") && (
                  <p className="text-xs mt-2">
                    Create an ACTIVE contract first — Programs must attach to
                    one.
                  </p>
                )}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Covers</TableHead>
                    <TableHead>Config</TableHead>
                    <TableHead>Assignments</TableHead>
                    <TableHead>Utilization</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {programList.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {PROGRAM_TYPE_META[p.type].label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-zinc-600">
                        {p.coveredPlanTypes.length > 0
                          ? p.coveredPlanTypes
                              .map(
                                (t) =>
                                  t.charAt(0) + t.slice(1).toLowerCase(),
                              )
                              .join(", ")
                          : <span className="text-zinc-400 italic">None</span>}
                      </TableCell>
                      <TableCell className="text-xs text-zinc-600">
                        {p.type === "LICENSED_SEAT" && p.licensedSeatConfig ? (
                          <>
                            {formatCurrencyAmount(
                              p.licensedSeatConfig.ratePerSeatPaise,
                              "INR",
                            )}{" "}
                            / seat /{" "}
                            {p.licensedSeatConfig.cycle.toLowerCase()} ·{" "}
                            {p.licensedSeatConfig.coveredEngagementsPerCycle ??
                              "unlimited"}{" "}
                            engagements ·{" "}
                            {
                              OVERAGE_BEHAVIOR_LABEL[
                                p.licensedSeatConfig.overageBehavior
                              ]
                            }
                          </>
                        ) : p.type === "CREDIT_POOL" && p.creditPoolConfig ? (
                          <>
                            {p.creditPoolConfig.creditBudgetPerCycle.toLocaleString(
                              "en-IN",
                            )}{" "}
                            credits (
                            {formatCurrencyAmount(
                              p.creditPoolConfig.creditBudgetPerCycle * 100,
                              "INR",
                            )}{" "}
                            cap) /{" "}
                            {p.creditPoolConfig.cycle.toLowerCase()} ·{" "}
                            {
                              OVERAGE_BEHAVIOR_LABEL[
                                p.creditPoolConfig.overageBehavior
                              ]
                            }
                            <span className="block text-[10px] text-zinc-400">
                              1 credit = ₹1 = 100 paise
                            </span>
                          </>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>{p._count.assignments}</TableCell>
                      <TableCell className="text-xs">
                        {(() => {
                          const u = programUtilization(p);
                          if (!u)
                            return <span className="text-zinc-400">—</span>;
                          return (
                            <span
                              className={
                                u.pct !== null && u.pct >= 80
                                  ? "font-medium text-amber-700"
                                  : "text-zinc-600"
                              }
                            >
                              {u.used} / {u.total}
                              {u.pct !== null ? ` (${u.pct}%)` : ""}
                            </span>
                          );
                        })()}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={
                            p.status === "ACTIVE"
                              ? "border-green-300 text-green-800"
                              : p.status === "PAUSED"
                                ? "border-amber-300 text-amber-800"
                                : "border-zinc-300 text-zinc-600"
                          }
                        >
                          {p.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {isAtLeast("MAINTAINER") && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setEditingProgram(p)}
                            >
                              <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setManagingProgram(p)}
                          >
                            <Users className="h-3.5 w-3.5 mr-1" /> Manage
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </DashboardContent>

      <CreateProgramDialog
        orgId={orgId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        contracts={contractList}
        capability={capability}
      />

      {editingProgram && (
        <EditProgramDialog
          orgId={orgId}
          programId={editingProgram.id}
          open={!!editingProgram}
          onOpenChange={(v) => {
            if (!v) setEditingProgram(null);
          }}
        />
      )}

      {managingProgram && (
        <ManageProgramDialog
          orgId={orgId}
          program={managingProgram}
          open={!!managingProgram}
          onOpenChange={(v) => {
            if (!v) setManagingProgram(null);
          }}
        />
      )}
    </>
  );
}
