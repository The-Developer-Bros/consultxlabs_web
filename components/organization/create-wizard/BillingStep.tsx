"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { billingSchema, type BillingFormData } from "./schemas";
import type { StepProps } from "./types";
import {
  FUNDING_SOURCE_LABEL,
  FUNDING_SOURCE_TAGLINE,
  SELF_SERVICE_FUNDING_SOURCES,
  narrowFundingSource,
} from "@/lib/labels/org-labels";
// WIP banner import removed — never rendered in this step, and
// per PR #655 reviewer feedback WIP banners are not production gates.

export function BillingStep({ onNext, onBack, initialData }: StepProps) {
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<BillingFormData>({
    resolver: zodResolver(billingSchema),
    defaultValues: {
      // Parse through the Zod enum so a prior-session hydration can't
      // seed the wizard with a PROJECT value the zod resolver would then
      // reject on submit with a confusing error.
      fundingSource: narrowFundingSource(initialData.fundingSource),
      paymentTermsDays: initialData.paymentTermsDays ?? 60,
    },
  });

  const fundingSource = watch("fundingSource");

  const onSubmit = (data: BillingFormData) => onNext(data);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <div className="space-y-2">
        <Label>Funding source</Label>
        <p className="text-xs text-zinc-500">
          How your organization pays when a member books a session.
        </p>
        <div className="space-y-2">
          {SELF_SERVICE_FUNDING_SOURCES.map((fs) => (
            <button
              key={fs}
              type="button"
              onClick={() => setValue("fundingSource", fs)}
              className={`w-full flex items-start gap-3 p-3 rounded-lg border text-left transition-colors ${
                fundingSource === fs
                  ? "border-zinc-900 bg-zinc-50 ring-1 ring-zinc-900"
                  : "border-zinc-200 hover:border-zinc-300"
              }`}
            >
              <div
                className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                  fundingSource === fs ? "border-zinc-900" : "border-zinc-300"
                }`}
              >
                {fundingSource === fs && (
                  <div className="w-2 h-2 rounded-full bg-zinc-900" />
                )}
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-900">
                  {FUNDING_SOURCE_LABEL[fs]}
                </p>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {FUNDING_SOURCE_TAGLINE[fs]}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* C4 (shipped): the reimbursement-report dashboard now lives at
          /dashboard/organization/[orgId]/reimbursements. Members pay with
          their own card; the org sees a per-member reimbursement total
          + CSV export. No banner needed — the surface is real now. */}

      {fundingSource === "INVOICE" && (
        <div className="space-y-2">
          <Label htmlFor="paymentTermsDays">Payment terms (days)</Label>
          <Input
            id="paymentTermsDays"
            type="number"
            min={1}
            max={120}
            {...register("paymentTermsDays")}
          />
          {errors.paymentTermsDays && (
            <p className="text-sm text-red-500">
              {errors.paymentTermsDays.message}
            </p>
          )}
          <p className="text-xs text-zinc-500">
            NET-{watch("paymentTermsDays") || 60} — monthly invoices are due
            within this window. India Net-60 is the default.
          </p>
        </div>
      )}

      <div className="flex justify-between pt-4">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button type="submit">Next</Button>
      </div>
    </form>
  );
}
