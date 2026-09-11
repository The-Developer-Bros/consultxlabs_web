"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Trash2, Copy } from "lucide-react";
import type { MemberRole, OrgStatus } from "@prisma/client";
import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
import { MEMBER_ROLE_LABEL, getInvitableRoles } from "@/lib/labels/org-labels";
import { humanizeOrgError } from "@/lib/labels/org-errors";
import {
  fetchOrgDetails,
  orgDetailsQueryKey,
} from "@/lib/api/organizations/org-details";
import {
  CreateInvitationPayloadSchema,
  CreateInvitationResponseSchema,
  InvitationsListResponseSchema,
  type InvitationRow,
} from "@/schemas/organizations";
import {
  parseJsonResponse,
  validateOutboundPayload,
  errorMessageFromBody,
} from "@/lib/fetch-helpers";
import type { z } from "zod";

type SelfServiceRole = z.infer<
  typeof CreateInvitationPayloadSchema
>["role"];

// Capability-aware role list. EXPERT only renders for canHost orgs;
// LEARNER only for canSponsor. Mirrors the server's EXPERT_REQUIRES_CANHOST
// + LEARNER_REQUIRES_CANSPONSOR guards in the invitations route.
function selectableRoles(
  canSponsor: boolean,
  canHost: boolean,
): Array<{ value: SelfServiceRole; label: string }> {
  return getInvitableRoles(canSponsor, canHost).map((value) => ({
    value: value as SelfServiceRole,
    label: MEMBER_ROLE_LABEL[value],
  }));
}

// Invitation.status is stored as a free-form string to stay aligned with
// BetterAuth's `member_invitations` bridge table. The three states the
// dashboard emits are lower-case; keep the label map scoped to those
// and fall back to the raw value for anything we don't recognise.
const INVITATION_STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  accepted: "Accepted",
  revoked: "Revoked",
  expired: "Expired",
};

import { PanelHeader } from "@/components/dashboard/PageScaffold";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// `InvitationRow` lives in `@/schemas/organizations` so the same shape
// powers the wizard, this page, and any future operator tooling.

async function fetchInvitations(
  orgId: string,
): Promise<{ invitations: InvitationRow[] }> {
  const res = await fetch(`/api/organizations/${orgId}/invitations`);
  const parsed = await parseJsonResponse(
    res,
    InvitationsListResponseSchema,
    "Failed to load invitations",
  );
  return { invitations: parsed.data };
}

async function createInvitation(
  orgId: string,
  payload: { email: string; role: SelfServiceRole },
) {
  const validated = validateOutboundPayload(
    CreateInvitationPayloadSchema,
    payload,
  );
  const res = await fetch(`/api/organizations/${orgId}/invitations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validated),
  });
  return parseJsonResponse(
    res,
    CreateInvitationResponseSchema,
    "Failed to create invitation",
  );
}

async function revokeInvitation(orgId: string, invitationId: string) {
  const res = await fetch(
    `/api/organizations/${orgId}/invitations/${invitationId}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(errorMessageFromBody(body, "Failed to revoke invitation"));
  }
}

export function MemberInvitationsPanel({ orgId }: { orgId: string }) {
  const { allowed } = useRequireOrgAccess(orgId, { permission: "invitations.manage" });
  const { canSponsor, canHost } = useOrgRole(orgId);
  const roleOptions = selectableRoles(canSponsor, canHost);
  // Same default-role logic as MembersPageClient: LEARNER if sponsor-capable,
  // EXPERT on host-only, MANAGER otherwise. Prevents an empty Select trigger
  // when LEARNER is filtered out of roleOptions on host-only orgs.
  const defaultRole: SelfServiceRole = (
    canSponsor ? "LEARNER" : canHost ? "EXPERT" : "MANAGER"
  ) as SelfServiceRole;
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["org-invitations", orgId],
    queryFn: () => fetchInvitations(orgId),
    // Don't fire the fetch until we know the caller passes the MAINTAINER
    // gate — otherwise non-privileged users who deep-link here get a 403
    // in the network tab before the redirect kicks in.
    enabled: allowed,
  });

  // Read the org the layout already fetched. We pass the same queryKey
  // + queryFn so react-query dedupes: if the layout's fetch has
  // finished (which it always has — the layout blocks child rendering
  // until the cache is warm), we read from the cache; otherwise we
  // kick the same fetch and the layout's call is joined to ours. React
  // Query v5 requires a queryFn even when `enabled` is false, so the
  // previous `enabled: false`-plus-no-queryFn trick crashed on mount.
  const { data: orgSnapshot } = useQuery({
    queryKey: orgDetailsQueryKey(orgId),
    queryFn: () => fetchOrgDetails(orgId),
    enabled: allowed,
    staleTime: 60_000,
  });
  const orgStatus: OrgStatus | undefined = orgSnapshot?.organization.status;
  const isPendingVerification = orgStatus === "PENDING_VERIFICATION";

  const [showCreate, setShowCreate] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<SelfServiceRole>(defaultRole);
  const [error, setError] = useState<string | null>(null);
  // Confirm-before-revoke so a mis-click doesn't nuke a pending invite
  // and force the user to re-send it. Using the same dialog primitives
  // as the rest of the dashboard rather than window.confirm() keeps the
  // styling consistent and shows which email is about to be revoked.
  const [invToRevoke, setInvToRevoke] = useState<InvitationRow | null>(null);

  const createMutation = useMutation({
    mutationFn: () => createInvitation(orgId, { email: email.trim(), role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-invitations", orgId] });
      setShowCreate(false);
      setEmail("");
      setError(null);
    },
    onError: (err: Error) => setError(humanizeOrgError(err.message)),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeInvitation(orgId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-invitations", orgId] });
      setInvToRevoke(null);
    },
  });

  if (!allowed) return null;

  const copyInviteLink = (invitationId: string) => {
    const url = `${window.location.origin}/organizations/invite/${invitationId}`;
    navigator.clipboard.writeText(url);
  };

  const columns: ResponsiveColumn<InvitationRow>[] = [
    {
      key: "email",
      header: "Email",
      primary: true,
      cell: (inv) => inv.email,
    },
    {
      key: "role",
      header: "Role",
      cell: (inv) => (
        <Badge variant="secondary">
          {MEMBER_ROLE_LABEL[inv.role as MemberRole] ?? inv.role}
        </Badge>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (inv) => (
        <Badge variant={inv.status === "pending" ? "default" : "outline"}>
          {INVITATION_STATUS_LABEL[inv.status] ?? inv.status}
        </Badge>
      ),
    },
    {
      key: "expires",
      header: "Expires",
      className: "text-xs text-muted-foreground",
      cell: (inv) => new Date(inv.expiresAt).toLocaleDateString(),
    },
  ];

  const renderRowActions = (inv: InvitationRow) => (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Copy invite link"
        onClick={() => copyInviteLink(inv.id)}
      >
        <Copy className="h-4 w-4" />
      </Button>
      {inv.status === "pending" && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Revoke invitation"
          onClick={() => setInvToRevoke(inv)}
        >
          <Trash2 className="h-4 w-4 text-red-500" />
        </Button>
      )}
    </div>
  );

  return (
    <>
      <PanelHeader
        description="Pending invitations to join this organization"
        actions={
          isPendingVerification ? (
            // Pre-empt the server's 409 ORG_NOT_VERIFIED — the banner at
            // the top of the dashboard already explains the state, so we
            // just disable the entry point and point back to it on hover.
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Button size="sm" disabled aria-disabled="true">
                      <Mail className="h-4 w-4 mr-1" /> Invite by email
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Available after your organization is verified.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Mail className="h-4 w-4 mr-1" /> Invite by email
            </Button>
          )
        }
      />
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {isLoading
                ? "Loading…"
                : `${data?.invitations.length ?? 0} invitations`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <ResponsiveTable<InvitationRow>
                columns={columns}
                rows={data?.invitations ?? []}
                getRowId={(inv) => inv.id}
                rowActions={renderRowActions}
                empty={
                  <p className="text-center text-sm text-muted-foreground py-6">
                    No pending invitations.
                  </p>
                }
              />
            )}
          </CardContent>
        </Card>
      </div>

      <ResponsiveModal open={showCreate} onOpenChange={setShowCreate}>
        <ResponsiveModalContent>
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>Send invitation</ResponsiveModalTitle>
            <ResponsiveModalDescription>
              The recipient does not need an account yet — they will create
              one when accepting the invite.
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="inv-email">Email</Label>
              <Input
                id="inv-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="alice@acme.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inv-role">Role</Label>
              <Select
                value={role}
                onValueChange={(v) => setRole(v as SelfServiceRole)}
              >
                <SelectTrigger id="inv-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roleOptions.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>

          <ResponsiveModalFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || !email.includes("@")}
            >
              {createMutation.isPending ? "Sending…" : "Send invitation"}
            </Button>
          </ResponsiveModalFooter>
        </ResponsiveModalContent>
      </ResponsiveModal>

      <ResponsiveModal
        open={!!invToRevoke}
        onOpenChange={(open) => !open && setInvToRevoke(null)}
      >
        <ResponsiveModalContent>
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>Revoke invitation?</ResponsiveModalTitle>
            <ResponsiveModalDescription>
              {invToRevoke?.email} will no longer be able to use their invite
              link. You can send a fresh invitation at any time.
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>
          <ResponsiveModalFooter>
            <Button
              variant="outline"
              onClick={() => setInvToRevoke(null)}
              disabled={revokeMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                invToRevoke && revokeMutation.mutate(invToRevoke.id)
              }
              disabled={revokeMutation.isPending}
            >
              {revokeMutation.isPending ? "Revoking…" : "Revoke invitation"}
            </Button>
          </ResponsiveModalFooter>
        </ResponsiveModalContent>
      </ResponsiveModal>
    </>
  );
}
