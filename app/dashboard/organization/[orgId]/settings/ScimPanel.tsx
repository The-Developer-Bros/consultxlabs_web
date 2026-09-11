"use client";

/**
 * /dashboard/organization/[orgId]/integrations/scim
 *
 * Manages SCIM 2.0 bearer tokens + group → role mappings for the org.
 *
 * Token creation is OWNER-only at the API layer (governance-sensitive
 * — a leaked SCIM token can provision arbitrary users). The page is
 * BILLING_ADMIN-reachable for the *read* surface; mutations submitted
 * by a non-OWNER role surface a 403 with friendly copy.
 *
 * Token reveal is one-shot — the raw value is rendered in the success
 * banner and never persisted client-side beyond that render.
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRequireOrgAccess, useOrgRole } from "../useOrgRole";
import { PanelHeader } from "@/components/dashboard/PageScaffold";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";

type ScimToken = {
  id: string;
  label: string;
  status: "ACTIVE" | "REVOKED";
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

type ScimMapping = {
  id: string;
  scimGroupName: string;
  role: string;
  createdAt: string;
};

const MAPPABLE_ROLES = [
  "OWNER",
  "MAINTAINER",
  "BILLING_ADMIN",
  "MANAGER",
  "EXPERT",
  "LEARNER",
  "SUPPORT",
] as const;

const tokenColumns: ResponsiveColumn<ScimToken>[] = [
  {
    key: "label",
    header: "Label",
    primary: true,
    className: "text-sm",
    cell: (t) => t.label,
  },
  {
    key: "status",
    header: "Status",
    cell: (t) => (
      <Badge
        className={
          t.status === "ACTIVE"
            ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
            : "bg-muted text-muted-foreground"
        }
      >
        {t.status}
      </Badge>
    ),
  },
  {
    key: "created",
    header: "Created",
    className: "text-xs text-muted-foreground",
    cell: (t) => new Date(t.createdAt).toLocaleDateString(),
  },
  {
    key: "lastUsed",
    header: "Last used",
    className: "text-xs text-muted-foreground",
    cell: (t) =>
      t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "never",
  },
];


export function ScimPanel({ orgId }: { orgId: string }) {
  const { allowed, isLoading: isGateLoading } = useRequireOrgAccess(orgId, { permission: "integrations.read" });
  const { role: viewerRole } = useOrgRole(orgId);
  const isOwner = viewerRole === "OWNER";
  const qc = useQueryClient();

  const [tokenLabel, setTokenLabel] = useState("");
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [groupRole, setGroupRole] =
    useState<(typeof MAPPABLE_ROLES)[number]>("LEARNER");
  const [actionError, setActionError] = useState<string | null>(null);

  const tokens = useQuery({
    queryKey: ["scim-tokens", orgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/scim/tokens`);
      if (!res.ok) throw new Error("Failed to load tokens");
      const body = (await res.json()) as { data: ScimToken[] };
      return body.data;
    },
    enabled: allowed,
  });

  const mappings = useQuery({
    queryKey: ["scim-group-mappings", orgId],
    queryFn: async () => {
      const res = await fetch(
        `/api/organizations/${orgId}/scim/group-mappings`,
      );
      if (!res.ok) throw new Error("Failed to load mappings");
      const body = (await res.json()) as { data: ScimMapping[] };
      return body.data;
    },
    enabled: allowed,
  });

  const createToken = useMutation({
    mutationFn: async (label: string) => {
      const res = await fetch(`/api/organizations/${orgId}/scim/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Token create failed");
      return body.token as ScimToken & { rawToken: string };
    },
    onSuccess: (token) => {
      setRevealedToken(token.rawToken);
      setTokenLabel("");
      setActionError(null);
      qc.invalidateQueries({ queryKey: ["scim-tokens", orgId] });
    },
    onError: (err) => setActionError(err.message),
  });

  const createMapping = useMutation({
    mutationFn: async (payload: { scimGroupName: string; role: string }) => {
      const res = await fetch(
        `/api/organizations/${orgId}/scim/group-mappings`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Mapping create failed");
      return body.mapping as ScimMapping;
    },
    onSuccess: () => {
      setGroupName("");
      setActionError(null);
      qc.invalidateQueries({ queryKey: ["scim-group-mappings", orgId] });
    },
    onError: (err) => setActionError(err.message),
  });

  if (isGateLoading || !allowed) return null;

  return (
    <>
      <PanelHeader description="Connect your IdP (Okta, Azure AD, OneLogin) to push and pull users via SCIM. Bearer tokens authenticate every call." />
      <div className="space-y-6">
        {actionError && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {actionError}
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Bearer tokens</CardTitle>
            <CardDescription>
              {isOwner
                ? "Mint a token, paste the raw value into your IdP's SCIM connector, then store it in your secrets manager."
                : "OWNERs mint and revoke SCIM tokens. Contact your OWNER if you need a new one issued."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isOwner && (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex-1 space-y-2 min-w-0">
                  <Label htmlFor="token-label">Token label</Label>
                  <Input
                    id="token-label"
                    value={tokenLabel}
                    onChange={(e) => setTokenLabel(e.target.value)}
                    placeholder="okta-prod / azure-staging / ..."
                  />
                </div>
                <Button
                  disabled={!tokenLabel || createToken.isPending}
                  onClick={() => createToken.mutate(tokenLabel)}
                >
                  {createToken.isPending ? "Minting..." : "Mint token"}
                </Button>
              </div>
            )}

            {revealedToken && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
                <p className="text-sm font-medium text-emerald-900">
                  Token minted. Copy now — you won&apos;t see this value
                  again.
                </p>
                <code className="mt-2 block break-all rounded bg-card px-2 py-1 text-xs">
                  {revealedToken}
                </code>
              </div>
            )}

            {tokens.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading tokens...</p>
            ) : (
              <ResponsiveTable<ScimToken>
                columns={tokenColumns}
                rows={tokens.data ?? []}
                getRowId={(t) => t.id}
                empty={
                  <p className="text-sm text-muted-foreground">
                    No SCIM tokens yet.
                  </p>
                }
              />
            )}
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Group → role mappings</CardTitle>
            <CardDescription>
              When SCIM provisions a user, their IdP group names are looked
              up here to resolve their org role. Unmapped users default to
              LEARNER.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isOwner && (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex-1 space-y-2 min-w-0">
                  <Label htmlFor="group-name">SCIM group name</Label>
                  <Input
                    id="group-name"
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    placeholder="IT-Admins / Finance-Leads / ..."
                  />
                </div>
                <div className="w-full space-y-2 sm:w-44">
                  <Label htmlFor="group-role">Role</Label>
                  <Select
                    value={groupRole}
                    onValueChange={(v) =>
                      setGroupRole(v as (typeof MAPPABLE_ROLES)[number])
                    }
                  >
                    <SelectTrigger id="group-role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MAPPABLE_ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {r}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  disabled={!groupName || createMapping.isPending}
                  onClick={() =>
                    createMapping.mutate({
                      scimGroupName: groupName,
                      role: groupRole,
                    })
                  }
                >
                  {createMapping.isPending ? "Adding..." : "Add mapping"}
                </Button>
              </div>
            )}

            {mappings.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading mappings...</p>
            ) : !mappings.data || mappings.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No group mappings yet.
              </p>
            ) : (
              // Narrow 3-column config table — fits a phone, so it keeps the
              // plain table behind a horizontal scroll rather than the
              // card-stack treatment used for the wider data tables.
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SCIM group</TableHead>
                      <TableHead>Maps to role</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mappings.data.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell>
                          <code className="text-xs">{m.scimGroupName}</code>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">{m.role}</Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(m.createdAt).toLocaleDateString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
