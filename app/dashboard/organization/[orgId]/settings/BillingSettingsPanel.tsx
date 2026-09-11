"use client";

/**
 * Billing settings — the two fields that are squarely finance's.
 *
 * The server has always allowed this: `BILLING_ADMIN_FIELDS` in
 * `app/api/organizations/[orgId]/route.ts` is exactly
 * `{ billingEmail, paymentTermsDays }`, and the PATCH field-level gate admits
 * BILLING_ADMIN for them. The UI never caught up. Both fields lived only on the
 * General panel, which is gated on `settings.manage` — GOVERNANCE, so OWNER and
 * MAINTAINER — and the disabled-state comments there pointed at "the billing
 * page", an affordance that was never built. The result was a finance role
 * holding `billing.manage` that could not edit the billing email.
 *
 * A separate tab rather than opening General to BILLING_ADMIN: General also
 * carries the org's name, slug, public listing, branding and tax identity, and
 * making it conditional in two directions leaves the next field someone adds
 * one oversight away from being editable by the wrong role. Here the gate is
 * the surface.
 *
 * OWNER keeps editing these on General too — that panel is unchanged, and the
 * server settles who may write what either way.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

import { useRequireOrgAccess } from "../useOrgRole";

interface BillingSettingsResponse {
  profile: {
    billingEmail: string | null;
    paymentTermsDays: number;
    version: number;
  };
  billingAccount?: { fundingSource?: string | null } | null;
}

async function fetchSettings(orgId: string): Promise<BillingSettingsResponse> {
  const res = await fetch(`/api/organizations/${orgId}/settings`);
  if (!res.ok) throw new Error("Failed to load settings");
  return res.json();
}

export function BillingSettingsPanel({ orgId }: Readonly<{ orgId: string }>) {
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "billing.manage",
  });
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["org-settings", orgId],
    queryFn: () => fetchSettings(orgId),
    enabled: allowed,
  });

  const [billingEmail, setBillingEmail] = useState("");
  const [paymentTermsDays, setPaymentTermsDays] = useState("60");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data) return;
    setBillingEmail(data.profile.billingEmail ?? "");
    setPaymentTermsDays(String(data.profile.paymentTermsDays));
  }, [data]);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          billingEmail: billingEmail.trim() || null,
          paymentTermsDays: parseInt(paymentTermsDays, 10),
          // Optimistic lock — the server CASes on this and 409s a stale tab,
          // which matters here because General edits the same row.
          ...(data && { expectedVersion: data.profile.version }),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error || "Failed to update billing settings");
      }
      return body;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-settings", orgId] });
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (err: Error) => {
      setError(err.message);
      setSaved(false);
    },
  });

  if (!allowed) return null;
  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (isError || !data) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Couldn&apos;t load billing settings. This is a loading problem, not a
          permissions one — refresh to try again.
        </AlertDescription>
      </Alert>
    );
  }

  const termsApply =
    data.billingAccount?.fundingSource !== "WALLET" &&
    data.billingAccount?.fundingSource !== "LICENSE";

  return (
    <div className="max-w-xl space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {saved && (
        <Alert>
          <AlertDescription>Billing settings saved.</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="billing-settings-email">Billing email</Label>
        <Input
          id="billing-settings-email"
          type="email"
          value={billingEmail}
          onChange={(e) => setBillingEmail(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Where invoices and dunning notices are sent.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="billing-settings-terms">Payment terms (days)</Label>
        <Input
          id="billing-settings-terms"
          type="number"
          min="1"
          max="120"
          value={paymentTermsDays}
          onChange={(e) => setPaymentTermsDays(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          India default is NET-60.{" "}
          {termsApply
            ? "Applies to invoices raised against this organization."
            : "This organization pre-funds or pays a flat fee, so invoice terms do not currently apply."}
        </p>
      </div>

      <Button
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending || !paymentTermsDays.trim()}
      >
        {mutation.isPending ? "Saving…" : "Save billing settings"}
      </Button>
    </div>
  );
}
