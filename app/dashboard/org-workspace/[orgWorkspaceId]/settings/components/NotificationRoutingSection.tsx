"use client";

/**
 * Section: notification routing preferences.
 *
 * Operator chooses where org-lifecycle events appear (bell, email, or
 * neither).
 *
 * The chosen mode is pushed onto the user's Novu subscriber record as
 * `data.routingMode` / `routingBell` / `routingEmail` by
 * `POST /api/novu/subscriber`, and the Novu workflow conditions gate the
 * channel steps on those flags — the same mechanism the category preferences
 * use. This docstring previously claimed `lib/novu/org-workflows.ts` read the
 * column directly; it never did, and the setting was inert (ADR 23).
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";

import { patchSettings } from "../utils/api";
import { NOTIFICATION_ROUTING_OPTIONS } from "../utils/options";
import type { NotificationRoutingMode } from "../utils/types";

interface NotificationRoutingSectionProps {
  orgWorkspaceId: string;
  current: NotificationRoutingMode;
}

export function NotificationRoutingSection({
  orgWorkspaceId,
  current,
}: NotificationRoutingSectionProps) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState<NotificationRoutingMode>(current);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const saveMutation = useMutation({
    mutationFn: () =>
      patchSettings(orgWorkspaceId, { notificationRoutingMode: value }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["org-workspace-settings", orgWorkspaceId],
      });
      setError(null);
      setSavedAt(new Date());
    },
    onError: (err: Error) => setError(err.message),
  });

  const dirty = current !== value;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Notification routing</CardTitle>
        <CardDescription>
          Where org-lifecycle events (invite-accepted, invoice-issued,
          payout-completed, SSO-cert-expiring, …) page you. Applies across
          all orgs you operate.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <RadioGroup
          value={value}
          onValueChange={(v) => setValue(v as NotificationRoutingMode)}
          className="space-y-3"
        >
          {NOTIFICATION_ROUTING_OPTIONS.map((opt) => (
            <div key={opt.value} className="flex items-start gap-3">
              <RadioGroupItem
                id={`routing-${opt.value}`}
                value={opt.value}
                className="mt-1"
              />
              <div className="space-y-0.5">
                <Label
                  htmlFor={`routing-${opt.value}`}
                  className="font-medium cursor-pointer"
                >
                  {opt.label}
                </Label>
                <p className="text-xs text-zinc-500">{opt.description}</p>
              </div>
            </div>
          ))}
        </RadioGroup>

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
