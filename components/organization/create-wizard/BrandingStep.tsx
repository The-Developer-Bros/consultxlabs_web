"use client";

import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Building2 } from "lucide-react";
import type { StepProps } from "./types";
import {
  FUNDING_SOURCE_LABEL,
  narrowFundingSource,
} from "@/lib/labels/org-labels";
import { brandingSchema, type BrandingFormData } from "./schemas";

const DEFAULT_PRIMARY = "#1a1a2e";
const DEFAULT_SECONDARY = "#16213e";

export function BrandingStep({
  onNext,
  onBack,
  initialData,
  isSubmitting,
}: StepProps) {
  // The native `<input type="color">` widget already constrains output
  // to a valid hex, so the Zod regex is belt-and-braces — but routing
  // through `zodResolver` keeps this step consistent with the others
  // and means a hand-edited `value=` (e.g. via React DevTools) still
  // hits the same validation as the server's PATCH body.
  const {
    control,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<BrandingFormData>({
    resolver: zodResolver(brandingSchema),
    defaultValues: {
      primaryColor: initialData.primaryColor ?? DEFAULT_PRIMARY,
      secondaryColor: initialData.secondaryColor ?? DEFAULT_SECONDARY,
    },
  });

  const primaryColor = watch("primaryColor") ?? DEFAULT_PRIMARY;
  const secondaryColor = watch("secondaryColor") ?? DEFAULT_SECONDARY;

  // Org creation is deferred to the Review step, so this step just
  // stashes the chosen palette on wizardData. ReviewStep does the
  // POST+PATCH with these values in one atomic flow.
  const onSubmit = (data: BrandingFormData) => {
    onNext({
      primaryColor: data.primaryColor ?? null,
      secondaryColor: data.secondaryColor ?? null,
    });
  };

  // Narrow the funding-source enum via Zod so the preview uses the
  // user-facing label instead of the raw uppercase value.
  const fundingLabel = initialData.fundingSource
    ? FUNDING_SOURCE_LABEL[narrowFundingSource(initialData.fundingSource)]
    : FUNDING_SOURCE_LABEL.PERSONAL;

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* Colors */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="primaryColor">Primary color</Label>
          <Controller
            control={control}
            name="primaryColor"
            render={({ field }) => (
              <div className="flex items-center gap-2">
                <input
                  id="primaryColor"
                  type="color"
                  value={field.value ?? DEFAULT_PRIMARY}
                  onChange={(e) => field.onChange(e.target.value)}
                  className="w-10 h-10 rounded border border-zinc-200 cursor-pointer"
                />
                <span className="text-sm text-zinc-500 font-mono">
                  {field.value ?? DEFAULT_PRIMARY}
                </span>
              </div>
            )}
          />
          {errors.primaryColor && (
            <p className="text-sm text-red-500">
              {errors.primaryColor.message}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="secondaryColor">Secondary color</Label>
          <Controller
            control={control}
            name="secondaryColor"
            render={({ field }) => (
              <div className="flex items-center gap-2">
                <input
                  id="secondaryColor"
                  type="color"
                  value={field.value ?? DEFAULT_SECONDARY}
                  onChange={(e) => field.onChange(e.target.value)}
                  className="w-10 h-10 rounded border border-zinc-200 cursor-pointer"
                />
                <span className="text-sm text-zinc-500 font-mono">
                  {field.value ?? DEFAULT_SECONDARY}
                </span>
              </div>
            )}
          />
          {errors.secondaryColor && (
            <p className="text-sm text-red-500">
              {errors.secondaryColor.message}
            </p>
          )}
        </div>
      </div>

      {/* Preview card */}
      <div className="rounded-xl border border-zinc-200 overflow-hidden">
        <div
          className="h-16"
          style={{ backgroundColor: primaryColor }}
        />
        <div className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-zinc-100 flex items-center justify-center overflow-hidden shrink-0">
            <Building2 className="w-5 h-5 text-zinc-400" />
          </div>
          <div>
            <p className="font-medium text-sm">
              {initialData.name || "Your Organization"}
            </p>
            <p
              className="text-xs"
              style={{ color: secondaryColor }}
            >
              {initialData.industry || "Industry"} &middot; {fundingLabel}
            </p>
          </div>
        </div>
      </div>

      <div className="flex justify-between pt-4">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onNext({})}
          >
            Skip for now
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            Next
          </Button>
        </div>
      </div>
    </form>
  );
}
