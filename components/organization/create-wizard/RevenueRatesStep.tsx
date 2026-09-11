"use client";

import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  revenueRatesSchema,
  type RevenueRatesFormData,
} from "./schemas";
import type { StepProps } from "./types";

// Defaults: 1000 / 1000 / 8000 basis points (10 / 10 / 80 %).
// These mirror `DEFAULT_RATE_CARD` in lib/api/organizations/rate-card.ts
// so an org that accepts the wizard defaults ends up with the same split
// the settlement code falls back to when no RateCard row exists.
const DEFAULT_PLATFORM_BPS = 1000;
const DEFAULT_ORG_BPS = 1000;
const DEFAULT_CONSULTANT_BPS = 8000;
const TOTAL_BPS = 10000;

/**
 * Percentages render with two decimals because 10000 bps / 100 = 100.00%
 * and we want the UI to mirror exactly what the DB stores. Dividing by
 * 100 converts bps → pct display; multiplying by 100 converts pct input
 * → bps. Anywhere there's arithmetic we stay in bps to avoid float drift.
 */
function bpsToPct(bps: number): string {
  return (bps / 100).toFixed(2);
}
function pctToBps(pct: string): number {
  const n = parseFloat(pct);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}

function clampBps(bps: number): number {
  return Math.min(TOTAL_BPS, Math.max(0, bps));
}

export function RevenueRatesStep({ onNext, onBack, initialData }: StepProps) {
  // Form state is bps integers (matches `revenueRatesSchema`); each
  // Controller owns the percent ↔ bps translation so the schema stays
  // the canonical contract. `mode: "onChange"` so the sum-refine error
  // (and the disabled state below) update live as the user types.
  const {
    control,
    handleSubmit,
    watch,
  } = useForm<RevenueRatesFormData>({
    resolver: zodResolver(revenueRatesSchema),
    mode: "onChange",
    defaultValues: {
      platformBps: initialData.platformBps ?? DEFAULT_PLATFORM_BPS,
      orgBps: initialData.orgBps ?? DEFAULT_ORG_BPS,
      consultantBps: initialData.consultantBps ?? DEFAULT_CONSULTANT_BPS,
    },
  });

  const platformBps = watch("platformBps");
  const orgBps = watch("orgBps");
  const consultantBps = watch("consultantBps");
  const sum = platformBps + orgBps + consultantBps;
  const isValid = sum === TOTAL_BPS;
  const diffBps = TOTAL_BPS - sum;

  const onSubmit = (data: RevenueRatesFormData) => onNext(data);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <p className="text-sm text-zinc-500">
        Each booking payment is split three ways. Percentages must sum to{" "}
        <strong>100%</strong> (10,000 basis points). You can adjust these
        later from organization settings — changes create a new rate card
        effective from the change date, so historical earnings stay at
        their original split.
      </p>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="platform-rate">Platform commission (%)</Label>
          <Controller
            control={control}
            name="platformBps"
            render={({ field }) => (
              <Input
                id="platform-rate"
                type="number"
                step="0.01"
                min={0}
                max={100}
                value={bpsToPct(field.value)}
                onChange={(e) => field.onChange(clampBps(pctToBps(e.target.value)))}
              />
            )}
          />
          <p className="text-xs text-zinc-500">Familiarise&apos;s fee per session.</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="org-rate">Organization share (%)</Label>
          <Controller
            control={control}
            name="orgBps"
            render={({ field }) => (
              <Input
                id="org-rate"
                type="number"
                step="0.01"
                min={0}
                max={100}
                value={bpsToPct(field.value)}
                onChange={(e) => field.onChange(clampBps(pctToBps(e.target.value)))}
              />
            )}
          />
          <p className="text-xs text-zinc-500">
            Your org&apos;s cut from each consultant&apos;s booking.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="consultant-rate">Consultant payout (%)</Label>
          <Controller
            control={control}
            name="consultantBps"
            render={({ field }) => (
              <Input
                id="consultant-rate"
                type="number"
                step="0.01"
                min={0}
                max={100}
                value={bpsToPct(field.value)}
                onChange={(e) => field.onChange(clampBps(pctToBps(e.target.value)))}
              />
            )}
          />
          <p className="text-xs text-zinc-500">
            What each consultant keeps. Can be overridden per consultant via
            a membership rate-card override.
          </p>
        </div>
      </div>

      {/* Live sum indicator — the schema's `.refine(sum === 10000)` is
          the authoritative gate, but showing the running total inline
          lets the user fix the split before they hit Next. */}
      <div
        className={`flex items-center justify-between rounded-lg px-4 py-3 text-sm font-medium ${
          isValid
            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
            : "bg-red-50 text-red-700 border border-red-200"
        }`}
      >
        <span>Total</span>
        <span>
          {bpsToPct(sum)}%{" "}
          {isValid
            ? "✓"
            : `— needs to be 100% (${diffBps > 0 ? "+" : ""}${bpsToPct(diffBps)}%)`}
        </span>
      </div>

      <div className="flex justify-between pt-4">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" disabled={!isValid}>
          Next
        </Button>
      </div>
    </form>
  );
}
