"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  CheckCircle,
  Clock,
  Loader2,
  PauseCircle,
  Search,
  XCircle,
} from "lucide-react";
import type { OrgStatus } from "@prisma/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OrgListItem {
  id: string;
  name: string;
  slug: string;
  status: OrgStatus;
  canSponsor: boolean;
  canHost: boolean;
  billingEmail: string;
  createdAt: string;
  billingAccount: { id: string; fundingSource: string } | null;
  _count: { memberships: number; contracts: number };
}

type VerifyAction = "VERIFY" | "SUSPEND" | "REACTIVATE" | "DEACTIVATE";

// ---------------------------------------------------------------------------
// API layer
// ---------------------------------------------------------------------------

async function fetchOrganizations(params: {
  status?: string;
  search?: string;
  page?: number;
}): Promise<{ data: OrgListItem[]; pagination: { total: number; page: number; pages: number } }> {
  const url = new URL("/api/admin/organizations", window.location.origin);
  if (params.status && params.status !== "ALL") url.searchParams.set("status", params.status);
  if (params.search) url.searchParams.set("search", params.search);
  if (params.page) url.searchParams.set("page", String(params.page));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error("Failed to load organizations");
  return res.json();
}

async function verifyOrg(
  orgId: string,
  action: VerifyAction,
  reason?: string,
): Promise<{ organization: OrgListItem }> {
  const res = await fetch(`/api/admin/organizations/${orgId}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, reason }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((json as { error?: string }).error ?? "Action failed");
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

const STATUS_BADGE: Record<OrgStatus, string> = {
  PENDING_VERIFICATION:
    "bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
  ACTIVE:
    "bg-green-50 text-green-800 border-green-300 dark:bg-green-950 dark:text-green-300 dark:border-green-800",
  SUSPENDED:
    "bg-red-50 text-red-700 border-red-300 dark:bg-red-950 dark:text-red-300 dark:border-red-800",
  DEACTIVATED: "bg-muted text-muted-foreground border-border",
};

const STATUS_ICON: Record<OrgStatus, React.ElementType> = {
  PENDING_VERIFICATION: Clock,
  ACTIVE: CheckCircle,
  SUSPENDED: PauseCircle,
  DEACTIVATED: XCircle,
};

function capabilityLabel(canSponsor: boolean, canHost: boolean) {
  if (canSponsor && canHost) return "Hybrid";
  if (canSponsor) return "Sponsor";
  if (canHost) return "Host";
  return "—";
}

// Actions available from each status
const ALLOWED_ACTIONS: Record<OrgStatus, VerifyAction[]> = {
  PENDING_VERIFICATION: ["VERIFY", "DEACTIVATE"],
  ACTIVE: ["SUSPEND", "DEACTIVATE"],
  SUSPENDED: ["REACTIVATE", "DEACTIVATE"],
  DEACTIVATED: [],
};

const ACTION_LABELS: Record<VerifyAction, string> = {
  VERIFY: "Verify",
  SUSPEND: "Suspend",
  REACTIVATE: "Reactivate",
  DEACTIVATE: "Deactivate",
};

const ACTION_VARIANT: Record<VerifyAction, string> = {
  VERIFY: "bg-green-600 hover:bg-green-700 text-white",
  SUSPEND: "bg-amber-600 hover:bg-amber-700 text-white",
  // REACTIVATE is a neutral restore action — keep it monochrome (was off-brand blue).
  REACTIVATE: "bg-primary text-primary-foreground hover:bg-primary/90",
  DEACTIVATE: "bg-red-600 hover:bg-red-700 text-white",
};

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

function ActionDialog({
  org,
  action,
  onClose,
  onConfirm,
  isPending,
  error,
}: {
  org: OrgListItem;
  action: VerifyAction;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  isPending: boolean;
  error: string | null;
}) {
  const [reason, setReason] = useState("");

  const descriptions: Record<VerifyAction, string> = {
    VERIFY:
      "This will mark the organization as ACTIVE. Members can be invited and money can move immediately.",
    SUSPEND:
      "Invitations and payments will be paused until the organization is reactivated. Existing memberships are preserved.",
    REACTIVATE:
      "The organization will return to ACTIVE status. All previously gated actions unlock immediately.",
    DEACTIVATE:
      "This is permanent and cannot be reversed from this endpoint. Use only for organizations that will never operate again.",
  };

  return (
    <AlertDialog open onOpenChange={(v) => !v && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {ACTION_LABELS[action]} &ldquo;{org.name}&rdquo;?
          </AlertDialogTitle>
          <AlertDialogDescription>{descriptions[action]}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="action-reason">
            Reason <span className="text-muted-foreground/70">(optional)</span>
          </Label>
          <Textarea
            id="action-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Docs verified by ops team, GSTIN confirmed"
            rows={3}
            className="text-sm"
          />
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose} disabled={isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            className={ACTION_VARIANT[action]}
            onClick={() => onConfirm(reason)}
            disabled={isPending}
          >
            {isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
                {ACTION_LABELS[action]}ing…
              </>
            ) : (
              ACTION_LABELS[action]
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminOrganizationsPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pendingAction, setPendingAction] = useState<{
    org: OrgListItem;
    action: VerifyAction;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const orgs = useQuery({
    queryKey: ["admin-orgs", statusFilter, debouncedSearch, page],
    queryFn: () =>
      fetchOrganizations({
        status: statusFilter,
        search: debouncedSearch,
        page,
      }),
  });

  const actionMutation = useMutation({
    mutationFn: ({ orgId, action, reason }: { orgId: string; action: VerifyAction; reason: string }) =>
      verifyOrg(orgId, action, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-orgs"] });
      setPendingAction(null);
      setActionError(null);
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const handleSearch = (val: string) => {
    setSearch(val);
    setPage(1);
    // Simple debounce: update after a brief pause
    setTimeout(() => setDebouncedSearch(val), 300);
  };

  const orgList = orgs.data?.data ?? [];
  const pagination = orgs.data?.pagination;

  // Pending count badge for the tab header
  const pendingCount = statusFilter === "PENDING_VERIFICATION"
    ? (pagination?.total ?? 0)
    : null;

  const renderRowActions = (org: OrgListItem) => {
    const actions = ALLOWED_ACTIONS[org.status];
    if (actions.length === 0) {
      return <span className="text-xs text-muted-foreground/70">No actions</span>;
    }
    return (
      <div className="flex items-center justify-end gap-1">
        {actions.map((action) => (
          <Button
            key={action}
            size="sm"
            variant="outline"
            className={
              action === "DEACTIVATE"
                ? "text-red-600 border-red-200 hover:bg-red-50 dark:text-red-400 dark:border-red-900 dark:hover:bg-red-950"
                : action === "SUSPEND"
                  ? "text-amber-700 border-amber-200 hover:bg-amber-50 dark:text-amber-400 dark:border-amber-900 dark:hover:bg-amber-950"
                  : ""
            }
            onClick={() => {
              setActionError(null);
              setPendingAction({ org, action });
            }}
          >
            {ACTION_LABELS[action]}
          </Button>
        ))}
      </div>
    );
  };

  const columns: ResponsiveColumn<OrgListItem>[] = [
    {
      key: "organization",
      header: "Organization",
      primary: true,
      cell: (org) => (
        <div>
          <p className="font-medium text-foreground">{org.name}</p>
          <p className="text-xs text-muted-foreground/70">{org.billingEmail}</p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (org) => {
        const StatusIcon = STATUS_ICON[org.status];
        return (
          <Badge
            variant="outline"
            className={`${STATUS_BADGE[org.status]} flex items-center gap-1 w-fit`}
          >
            <StatusIcon className="h-3 w-3" />
            {org.status.replace(/_/g, " ")}
          </Badge>
        );
      },
    },
    {
      key: "capability",
      header: "Capability",
      className: "text-sm text-muted-foreground",
      cell: (org) => capabilityLabel(org.canSponsor, org.canHost),
    },
    {
      key: "funding",
      header: "Funding",
      className: "text-sm text-muted-foreground",
      cell: (org) => org.billingAccount?.fundingSource ?? "—",
    },
    {
      key: "members",
      header: "Members",
      className: "text-sm text-muted-foreground",
      cell: (org) => org._count.memberships,
    },
    {
      key: "created",
      header: "Created",
      className: "text-sm text-muted-foreground",
      cell: (org) => fmtDate(org.createdAt),
    },
  ];

  const emptyState = (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
      <Building2 className="h-10 w-10 mb-3 text-muted-foreground/40" />
      <p className="text-sm">No organizations found.</p>
    </div>
  );

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="Organizations"
        subtitle="Review pending organizations and manage their lifecycle status."
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full min-w-0 sm:w-auto sm:max-w-sm sm:flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground/70" />
          <Input
            placeholder="Search by name, email, or slug…"
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-full sm:w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All statuses</SelectItem>
            <SelectItem value="PENDING_VERIFICATION">Pending verification</SelectItem>
            <SelectItem value="ACTIVE">Active</SelectItem>
            <SelectItem value="SUSPENDED">Suspended</SelectItem>
            <SelectItem value="DEACTIVATED">Deactivated</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                {orgs.isLoading ? (
                  "Loading…"
                ) : (
                  <>
                    {pagination?.total ?? 0} organization
                    {(pagination?.total ?? 0) !== 1 ? "s" : ""}
                    {pendingCount !== null && pendingCount > 0 && (
                      <Badge className="bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800 text-xs">
                        {pendingCount} pending
                      </Badge>
                    )}
                  </>
                )}
              </CardTitle>
              <CardDescription className="mt-0.5">
                Use Verify to activate a pending org. Suspend pauses an active one.
                Deactivate is terminal.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {orgs.isLoading ? (
            <div className="flex items-center justify-center py-16 gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <div className="p-4">
              <ResponsiveTable<OrgListItem>
                columns={columns}
                rows={orgList}
                getRowId={(o) => o.id}
                rowActions={renderRowActions}
                empty={emptyState}
              />
            </div>
          )}

          {/* Pagination */}
          {pagination && pagination.pages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border text-sm text-muted-foreground">
              <span>
                Page {pagination.page} of {pagination.pages} ({pagination.total} total)
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page >= pagination.pages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Action confirmation dialog */}
      {pendingAction && (
        <ActionDialog
          org={pendingAction.org}
          action={pendingAction.action}
          onClose={() => {
            setPendingAction(null);
            setActionError(null);
          }}
          onConfirm={(reason) =>
            actionMutation.mutate({
              orgId: pendingAction.org.id,
              action: pendingAction.action,
              reason,
            })
          }
          isPending={actionMutation.isPending}
          error={actionError}
        />
      )}
    </div>
  );
}
