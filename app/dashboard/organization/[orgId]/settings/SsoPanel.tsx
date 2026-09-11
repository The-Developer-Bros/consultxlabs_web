"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Copy, Check } from "lucide-react";
import { useRequireOrgRole } from "../useOrgRole";
import { useToast } from "@/hooks/use-toast";
import { deriveAcsUrl, deriveMetadataUrl } from "@/lib/sso/derive-urls";
import {
  CreateSsoProviderPayloadSchema,
  PatchSsoSettingsPayloadSchema,
  SsoSettingsResponseSchema,
  type CreateSsoProviderPayload,
  type SsoSettingsResponse,
} from "@/schemas/organizations";
import {
  parseJsonResponse,
  validateOutboundPayload,
  errorMessageFromBody,
} from "@/lib/fetch-helpers";

import { PanelHeader } from "@/components/dashboard/PageScaffold";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";


import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// SsoResponse shape is imported from `@/schemas/organizations` so the
// same definitions back the UI, the payload validators, and any future
// operator/admin tooling.

type SsoProvider = SsoSettingsResponse["providers"][number];

const providerColumns: ResponsiveColumn<SsoProvider>[] = [
  {
    key: "providerId",
    header: "Provider ID",
    primary: true,
    cell: (p) => <Badge variant="secondary">{p.providerId}</Badge>,
  },
  {
    key: "type",
    header: "Type",
    className: "text-xs uppercase text-muted-foreground",
    cell: (p) => p.providerType ?? "—",
  },
  {
    key: "domain",
    header: "Domain",
    cell: (p) => p.domain,
  },
  {
    key: "idpUrls",
    header: "IdP setup URLs",
    className: "space-y-1.5 py-3",
    cell: (p) => (
      <div className="space-y-1.5">
        <CopyableUrl
          label={p.providerType === "oidc" ? "Redirect URI" : "ACS URL"}
          value={deriveAcsUrl(p.providerId, p.providerType)}
        />
        {p.providerType === "saml" && (
          <CopyableUrl
            label="SP Metadata URL"
            value={deriveMetadataUrl(p.providerId)}
          />
        )}
      </div>
    ),
  },
];

function CopyableUrl({ label, value }: { label: string; value: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast({ title: "Copied", description: label });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };
  return (
    <div className="space-y-1">
      <p className="text-xs uppercase tracking-wide text-zinc-500">{label}</p>
      <div className="flex items-center gap-2 rounded-md bg-white border border-zinc-200 px-2 py-1">
        <code className="flex-1 text-xs font-mono text-zinc-700 break-all select-all">
          {value}
        </code>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={`Copy ${label}`}
          onClick={handleCopy}
          className="h-6 w-6 flex-shrink-0"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-green-600" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}

async function fetchSso(orgId: string): Promise<SsoSettingsResponse> {
  const res = await fetch(`/api/organizations/${orgId}/sso`);
  return parseJsonResponse(
    res,
    SsoSettingsResponseSchema,
    "Failed to load SSO settings",
  );
}

type PatchPayload = {
  allowedEmailDomains?: string[];
  enforceSSO?: boolean;
  // Locked to LEARNER per JIT principle-of-least-privilege (audit
  // Phase A.1). The API rejects any other role with 400 even if the
  // client sends one.
  defaultRoleForAutoJoin?: "LEARNER";
};

async function patchSso(orgId: string, payload: PatchPayload) {
  const validated = validateOutboundPayload(
    PatchSsoSettingsPayloadSchema,
    payload,
  );
  const res = await fetch(`/api/organizations/${orgId}/sso`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validated),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorMessageFromBody(body, "Failed to update SSO settings"));
  return body;
}

async function createProvider(orgId: string, payload: CreateSsoProviderPayload) {
  // Discriminated union enforces "providerType: 'saml' ⇒ samlConfig" and
  // "providerType: 'oidc' ⇒ oidcConfig" — flipping the radio without
  // re-validating the matching config block fails before we hit the wire.
  const validated = validateOutboundPayload(
    CreateSsoProviderPayloadSchema,
    payload,
  );
  const res = await fetch(`/api/organizations/${orgId}/sso/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validated),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorMessageFromBody(body, "Failed to register provider"));
  return body;
}

async function deleteProvider(orgId: string, providerId: string) {
  const res = await fetch(
    `/api/organizations/${orgId}/sso/providers/${providerId}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(errorMessageFromBody(body, "Failed to delete provider"));
  }
}

// Auto-join via SSO is hard-locked to LEARNER (audit Phase A.1). The
// prior "pick a role" dropdown allowed OWNER → catastrophic privilege
// grant when SSO was enabled. Admins promote explicitly via the
// members page after first signin; that path is audit-logged.
//
// EXPERT remains invite-driven (the ConsultantProfile FK is wired by
// the invite-accept path), SUPPORT is manual, OWNER/MAINTAINER/MANAGER
// require deliberate action. LEARNER is the only safe auto-grant.

export function SsoPanel({ orgId }: { orgId: string }) {
  const { allowed } = useRequireOrgRole(orgId, "OWNER");
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["org-sso", orgId],
    queryFn: () => fetchSso(orgId),
    // SSO settings are OWNER-only. Gate the fetch so non-owners who
    // land here via direct URL don't trigger a 403 before the redirect.
    enabled: allowed,
  });

  const [domains, setDomains] = useState("");
  const [enforce, setEnforce] = useState(false);

  useEffect(() => {
    if (!data) return;
    setDomains(data.settings.allowedEmailDomains.join(", "));
    setEnforce(data.settings.enforceSSO);
  }, [data]);

  const settingsMutation = useMutation({
    mutationFn: () =>
      patchSso(orgId, {
        allowedEmailDomains: domains
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        enforceSSO: enforce,
        // defaultRoleForAutoJoin is locked to LEARNER server-side; we
        // don't send it in the PATCH so the API can keep its existing
        // default-on-create logic without our form forcing a value.
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["org-sso", orgId] }),
  });

  const [showAdd, setShowAdd] = useState(false);
  const [providerType, setProviderType] = useState<"saml" | "oidc">("saml");
  const [providerId, setProviderId] = useState("");
  const [domain, setDomain] = useState("");
  const [issuer, setIssuer] = useState("");
  // SAML fields
  const [samlEntryPoint, setSamlEntryPoint] = useState("");
  const [samlCert, setSamlCert] = useState("");
  // OIDC fields
  const [oidcClientId, setOidcClientId] = useState("");
  const [oidcClientSecret, setOidcClientSecret] = useState("");
  const [oidcDiscoveryUrl, setOidcDiscoveryUrl] = useState("");
  const [providerError, setProviderError] = useState<string | null>(null);

  const createProviderMutation = useMutation({
    mutationFn: () => {
      // Build the discriminated payload up-front so TS narrows correctly
      // and the schema's union sees a complete object.
      const payload: CreateSsoProviderPayload =
        providerType === "saml"
          ? {
              providerId: providerId.trim(),
              domain: domain.trim(),
              issuer: issuer.trim(),
              providerType: "saml",
              samlConfig: {
                issuer: issuer.trim(),
                entryPoint: samlEntryPoint.trim(),
                cert: samlCert.trim(),
              },
            }
          : {
              providerId: providerId.trim(),
              domain: domain.trim(),
              issuer: issuer.trim(),
              providerType: "oidc",
              oidcConfig: {
                issuer: issuer.trim(),
                clientId: oidcClientId.trim(),
                clientSecret: oidcClientSecret.trim(),
                discoveryEndpoint: oidcDiscoveryUrl.trim(),
                pkce: true,
              },
            };
      return createProvider(orgId, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-sso", orgId] });
      setShowAdd(false);
      setProviderId("");
      setDomain("");
      setIssuer("");
      setSamlEntryPoint("");
      setSamlCert("");
      setOidcClientId("");
      setOidcClientSecret("");
      setOidcDiscoveryUrl("");
      setProviderError(null);
    },
    onError: (err: Error) => setProviderError(err.message),
  });

  const deleteProviderMutation = useMutation({
    mutationFn: (id: string) => deleteProvider(orgId, id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["org-sso", orgId] }),
  });

  if (!allowed) return null;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <>
      {/* No "Back to settings" button — this is a tab within Settings now,
          so the tab bar above already is the way back. */}
      <PanelHeader description="Configure SAML or OIDC sign-in for this organization" />
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Domain policy</CardTitle>
            <CardDescription>
              Users signing up with these email domains can be auto-joined to
              this organization.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                settingsMutation.mutate();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="domains">Allowed email domains</Label>
                <Input
                  id="domains"
                  value={domains}
                  onChange={(e) => setDomains(e.target.value)}
                  placeholder="acme.com, acme.edu"
                />
                <p className="text-xs text-zinc-500">
                  Comma-separated list of domains.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-zinc-200 p-3">
                <div>
                  <p className="text-sm font-medium">Enforce SSO</p>
                  <p className="text-xs text-zinc-500">
                    Reject password and personal OAuth sign-ins for these
                    domains.
                  </p>
                </div>
                <Switch checked={enforce} onCheckedChange={setEnforce} />
              </div>

              <div className="space-y-2">
                <Label>Default role for auto-joined users</Label>
                <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
                  Learner
                </div>
                <p className="text-xs text-zinc-500">
                  New users who sign in via SSO for the first time are
                  always granted the Learner role. Promote them
                  explicitly from the Members page after their first
                  sign-in — this keeps the audit trail of role grants
                  deliberate and least-privilege.
                </p>
              </div>

              <div>
                <Button type="submit" disabled={settingsMutation.isPending}>
                  {settingsMutation.isPending ? "Saving…" : "Save policy"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">SSO providers</CardTitle>
              <CardDescription>
                SAML and OIDC providers registered for this organization.
              </CardDescription>
            </div>
            <Button size="sm" onClick={() => setShowAdd(true)}>
              <Plus className="h-4 w-4 mr-1" /> Add provider
            </Button>
          </CardHeader>
          <CardContent>
            <ResponsiveTable<SsoProvider>
              columns={providerColumns}
              rows={data?.providers ?? []}
              getRowId={(p) => p.id}
              rowActions={(p) => (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Delete provider"
                  onClick={() => deleteProviderMutation.mutate(p.id)}
                >
                  <Trash2 className="h-4 w-4 text-red-500" />
                </Button>
              )}
              empty={
                <p className="text-center text-sm text-muted-foreground py-6">
                  No providers configured yet.
                </p>
              }
            />
          </CardContent>
        </Card>
      </div>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add SSO provider</DialogTitle>
            <DialogDescription>
              Configure a SAML or OIDC identity provider for this organization.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="prov-id">Provider ID</Label>
              <Input
                id="prov-id"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
                placeholder="acme-okta"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="prov-domain">Domain</Label>
              <Input
                id="prov-domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="acme.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="prov-issuer">Issuer</Label>
              <Input
                id="prov-issuer"
                value={issuer}
                onChange={(e) => setIssuer(e.target.value)}
                placeholder="https://idp.acme.com"
              />
            </div>
            <div className="space-y-2">
              <Label>Provider type</Label>
              <Select value={providerType} onValueChange={(v) => setProviderType(v as "saml" | "oidc")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="saml">SAML</SelectItem>
                  <SelectItem value="oidc">OIDC</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="rounded-md bg-zinc-50 border border-zinc-200 p-3 space-y-3">
              <p className="text-sm font-medium text-zinc-700">
                Configure these values in your IdP
              </p>
              <CopyableUrl
                label={
                  providerType === "saml" ? "ACS / Callback URL" : "Redirect URI"
                }
                value={deriveAcsUrl(providerId, providerType)}
              />
              {providerType === "saml" && (
                <CopyableUrl
                  label="SP Metadata URL (Entity ID)"
                  value={deriveMetadataUrl(providerId)}
                />
              )}
              <p className="text-xs text-zinc-500">
                Paste these into your IdP app configuration (Okta, Auth0, Azure
                AD, Google Workspace). URLs update when you change the Provider
                ID above.
              </p>
            </div>
            {providerType === "saml" ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="saml-entry">SSO entry point URL</Label>
                  <Input
                    id="saml-entry"
                    value={samlEntryPoint}
                    onChange={(e) => setSamlEntryPoint(e.target.value)}
                    placeholder="https://idp.acme.com/sso/saml"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="saml-cert">X.509 certificate</Label>
                  <textarea
                    id="saml-cert"
                    value={samlCert}
                    onChange={(e) => setSamlCert(e.target.value)}
                    className="w-full min-h-20 rounded-md border border-zinc-300 px-3 py-2 text-sm font-mono"
                    placeholder="MIICpDCCAYwCCQC..."
                  />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="oidc-client-id">Client ID</Label>
                  <Input
                    id="oidc-client-id"
                    value={oidcClientId}
                    onChange={(e) => setOidcClientId(e.target.value)}
                    placeholder="abc123..."
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="oidc-secret">Client secret</Label>
                  <Input
                    id="oidc-secret"
                    type="password"
                    value={oidcClientSecret}
                    onChange={(e) => setOidcClientSecret(e.target.value)}
                    placeholder="secret..."
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="oidc-discovery">Discovery URL</Label>
                  <Input
                    id="oidc-discovery"
                    value={oidcDiscoveryUrl}
                    onChange={(e) => setOidcDiscoveryUrl(e.target.value)}
                    placeholder="https://idp.acme.com/.well-known/openid-configuration"
                  />
                </div>
              </>
            )}
            {providerError && (
              <p className="text-sm text-red-600">{providerError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createProviderMutation.mutate()}
              disabled={createProviderMutation.isPending}
            >
              {createProviderMutation.isPending ? "Adding…" : "Add provider"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
