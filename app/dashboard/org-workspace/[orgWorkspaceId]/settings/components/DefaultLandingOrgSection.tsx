"use client";

/**
 * Section: default landing organisation.
 *
 * Operator picks which of their OWNER orgs opens when the workspace
 * shell is reached without a specific orgId. Server validates the
 * selection against the caller's ACTIVE OWNER memberships.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { patchSettings } from "../utils/api";
import type { CandidateOrg } from "../utils/types";

const NO_PREFERENCE_VALUE = "__none__";

interface DefaultLandingOrgSectionProps {
  orgWorkspaceId: string;
  current: string | null;
  candidates: CandidateOrg[];
}

export function DefaultLandingOrgSection({
  orgWorkspaceId,
  current,
  candidates,
}: DefaultLandingOrgSectionProps) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState<string>(current ?? NO_PREFERENCE_VALUE);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const saveMutation = useMutation({
    mutationFn: () =>
      patchSettings(orgWorkspaceId, {
        defaultLandingOrganizationId:
          value === NO_PREFERENCE_VALUE ? null : value,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["org-workspace-settings", orgWorkspaceId],
      });
      setError(null);
      setSavedAt(new Date());
    },
    onError: (err: Error) => setError(err.message),
  });

  const dirty = (current ?? NO_PREFERENCE_VALUE) !== value;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Default landing organisation</CardTitle>
        <CardDescription>
          Open this org by default when you reach the workspace dashboard
          without a specific org in the URL. You can always switch via the
          organisation switcher in the top bar.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="default-landing-org">Organisation</Label>
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger id="default-landing-org">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PREFERENCE_VALUE}>
                No preference — show the operator overview
              </SelectItem>
              {candidates.map((org) => (
                <SelectItem key={org.id} value={org.id}>
                  {org.name}
                  {org.status !== "ACTIVE" ? ` (${org.status})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {candidates.length === 0 && (
            <p className="text-xs text-zinc-500">
              You don’t OWN any organisations yet. Create one from the
              workspace home to enable this setting.
            </p>
          )}
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {savedAt && !dirty && !error && (
          <p className="text-xs text-green-700">
            Saved at {savedAt.toLocaleTimeString()}.
          </p>
        )}

        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={!dirty || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving…
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-1" /> Save
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
