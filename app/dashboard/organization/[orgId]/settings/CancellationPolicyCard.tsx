"use client";

/**
 * The org's refund ladder (#1499).
 *
 * A published version is immutable, so this card is not an editor of one row: it
 * shows the version that is live, lets an OWNER compose the next one, and publishing
 * archives the previous version. Bookings already sold keep the terms they were sold
 * under, which is the whole reason the versions exist.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_POLICY_TIERS } from "@/lib/payments/operations/cancellation-policy";

type TierRow = { hoursBefore: string; refundPct: string };

type PolicyTerms = {
  policyId: string | null;
  source: "PLATFORM" | "ORG";
  version: number;
  tiers: { hoursBefore: number; refundPct: number }[];
  consultantInitiatedPct: number;
  createdAt?: string;
};

type PolicyResponse = {
  policy: PolicyTerms | null;
  platformDefault: PolicyTerms;
};

const policyQueryKey = (orgId: string) => ["org-cancellation-policy", orgId];

async function fetchPolicy(orgId: string): Promise<PolicyResponse> {
  const res = await fetch(`/api/organizations/${orgId}/cancellation-policy`);
  if (!res.ok) throw new Error("Failed to load the cancellation policy");
  return res.json();
}

function toRows(terms: PolicyTerms): TierRow[] {
  return terms.tiers.map((tier) => ({
    hoursBefore: String(tier.hoursBefore),
    refundPct: String(tier.refundPct),
  }));
}

export function CancellationPolicyCard({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: policyQueryKey(orgId),
    queryFn: () => fetchPolicy(orgId),
  });

  const [rows, setRows] = useState<TierRow[]>([]);
  const [consultantInitiatedPct, setConsultantInitiatedPct] = useState("100");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // The form starts from whatever is live — the org's own version if it has one,
  // otherwise the platform ladder its bookings are already governed by, so an OWNER
  // edits the real terms rather than an empty table.
  useEffect(() => {
    if (!data) return;
    const terms = data.policy ?? data.platformDefault;
    setRows(toRows(terms));
    setConsultantInitiatedPct(String(terms.consultantInitiatedPct));
  }, [data]);

  const mutation = useMutation({
    mutationFn: async () => {
      // #1513 review — every field is a string from a text input, and
      // `Number("")` is 0. An OWNER who cleared a box and hit publish would have
      // published an immutable version carrying a 0-hour, 0% rung they never
      // typed, and immutable means there is no editing it back. Refuse instead.
      const tiers = rows.map((row) => ({
        hoursBefore: row.hoursBefore.trim(),
        refundPct: row.refundPct.trim(),
      }));
      const consultantPct = consultantInitiatedPct.trim();
      const isNumeric = (value: string) =>
        value !== "" && Number.isFinite(Number(value));
      const everyFieldFilled =
        tiers.every(
          (tier) => isNumeric(tier.hoursBefore) && isNumeric(tier.refundPct),
        ) && isNumeric(consultantPct);
      if (!everyFieldFilled) {
        throw new Error(
          "Every tier needs a notice period and a refund percentage",
        );
      }

      const res = await fetch(
        `/api/organizations/${orgId}/cancellation-policy`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tiers: tiers.map((tier) => ({
              hoursBefore: Number(tier.hoursBefore),
              refundPct: Number(tier.refundPct),
            })),
            consultantInitiatedPct: Number(consultantPct),
          }),
        },
      );
      const body = await res.json();
      if (!res.ok)
        throw new Error(
          body.error || "Failed to publish the cancellation policy",
        );
      return body;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: policyQueryKey(orgId) });
      queryClient.invalidateQueries({ queryKey: ["org-settings", orgId] });
      setError(null);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2500);
    },
    onError: (err: Error) => {
      setSuccess(false);
      setError(err.message);
    },
  });

  // #1513 review — a failed load used to render nothing at all, so an OWNER on
  // a flaky connection saw a settings page with no cancellation policy on it and
  // no way to tell that from an organisation that has none. Say so, and offer
  // the retry.
  if (isError) {
    return (
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Cancellation policy</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <p className="text-sm text-red-600">
            We could not load your cancellation policy.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refetch()}
          >
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (isLoading || !data) return null;

  const live = data.policy;

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Cancellation policy</CardTitle>
        <CardDescription>
          {live
            ? `Version ${live.version} is live${
                live.createdAt
                  ? `, published on ${new Date(live.createdAt).toLocaleDateString()}`
                  : ""
              }. It applies to the sessions this organisation funds.`
            : "This organisation is using the platform default. Publishing your own ladder replaces it for the sessions you fund."}{" "}
          Publishing replaces your policy for future bookings only. Bookings
          already paid for keep the terms they were sold under.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          {rows.map((row, index) => (
            <div key={index} className="flex items-end gap-3">
              <div className="flex-1">
                <Label
                  htmlFor={`tier-hours-${index}`}
                  className="text-xs text-zinc-500"
                >
                  Cancelled at least this many hours before
                </Label>
                <Input
                  id={`tier-hours-${index}`}
                  type="number"
                  min={0}
                  max={8760}
                  value={row.hoursBefore}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((existing, i) =>
                        i === index
                          ? { ...existing, hoursBefore: event.target.value }
                          : existing,
                      ),
                    )
                  }
                />
              </div>
              <div className="flex-1">
                <Label
                  htmlFor={`tier-pct-${index}`}
                  className="text-xs text-zinc-500"
                >
                  Refund (%)
                </Label>
                <Input
                  id={`tier-pct-${index}`}
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={row.refundPct}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((existing, i) =>
                        i === index
                          ? { ...existing, refundPct: event.target.value }
                          : existing,
                      ),
                    )
                  }
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove tier ${index + 1}`}
                disabled={rows.length <= 1 || mutation.isPending}
                onClick={() =>
                  setRows((current) => current.filter((_, i) => i !== index))
                }
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
          <p className="text-xs text-zinc-500">
            The last tier must start at 0 hours, so every cancellation is
            covered by one of the rungs above.
          </p>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={rows.length >= MAX_POLICY_TIERS || mutation.isPending}
          onClick={() =>
            setRows((current) => [
              ...current,
              { hoursBefore: "0", refundPct: "0" },
            ])
          }
        >
          <Plus className="w-4 h-4 mr-1" /> Add tier
        </Button>

        <div className="max-w-xs">
          <Label
            htmlFor="consultant-initiated-pct"
            className="text-xs text-zinc-500"
          >
            When the consultant or our team cancels (%)
          </Label>
          <Input
            id="consultant-initiated-pct"
            type="number"
            min={0}
            max={100}
            step="0.01"
            value={consultantInitiatedPct}
            onChange={(event) => setConsultantInitiatedPct(event.target.value)}
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {success && (
          <p className="text-sm text-emerald-600">
            Published. New bookings will be sold under this version.
          </p>
        )}
      </CardContent>
      <CardFooter>
        <Button
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || rows.length === 0}
        >
          {mutation.isPending ? "Publishing…" : "Publish new version"}
        </Button>
      </CardFooter>
    </Card>
  );
}
