"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useSession } from "@/lib/auth-client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { orgInfoSchema, type OrgInfoFormData } from "./schemas";
import type { StepProps } from "./types";

// Why no WIP banner import: per PR #655 reviewer feedback ("WIP banners
// are not production gates"), `canHost: true` is hard-gated server-side
// at app/api/organizations/route.ts (returns 400 HOST_ORGS_GATED when
// ENABLE_HOST_ORGS is unset). The wizard's submit path catches that
// code and surfaces the friendly copy from lib/labels/org-errors.ts.

const INDUSTRIES = [
  "Education",
  "Technology",
  "Healthcare",
  "Finance",
  "Legal",
  "Government",
  "Non-profit",
  "Manufacturing",
  "Consulting",
  "Other",
];

const SIZE_BUCKETS = [
  { value: "SMALL_1_50", label: "1-50 employees" },
  { value: "MEDIUM_51_200", label: "51-200 employees" },
  { value: "LARGE_201_1000", label: "201-1000 employees" },
  { value: "ENTERPRISE_1000_PLUS", label: "1000+ employees" },
];

export function OrgInfoStep({
  onNext,
  onBack,
  canGoBack,
  initialData,
  isSubmitting,
  hostOrgsEnabled = false,
}: StepProps) {
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<OrgInfoFormData>({
    resolver: zodResolver(orgInfoSchema),
    defaultValues: {
      name: initialData.name ?? "",
      billingEmail: initialData.billingEmail ?? "",
      description: initialData.description ?? "",
      industry: initialData.industry ?? "",
      sizeBucket: initialData.sizeBucket ?? "",
      website: initialData.website ?? "",
      canSponsor: initialData.canSponsor ?? true,
      canHost: initialData.canHost ?? false,
    },
  });

  const canSponsor = watch("canSponsor");
  const canHost = watch("canHost");
  const billingEmail = watch("billingEmail");
  const [capabilityError, setCapabilityError] = useState<string | null>(null);

  const { data: session } = useSession();
  const profileEmail = session?.user?.email ?? "";
  const usingProfileEmail = !!profileEmail && billingEmail === profileEmail;

  const onSubmit = (data: OrgInfoFormData) => {
    // Belt-and-braces: the zod schema doesn't enforce "at least one
    // capability" because both fields are individually valid booleans.
    // Catch the misconfiguration here before advancing — otherwise the
    // wizard would skip both billing and revenue-rates steps and land
    // on a useless inert org.
    if (!data.canSponsor && !data.canHost) {
      setCapabilityError(
        "Pick at least one capability. An organization that neither sponsors members nor hosts consultants has nothing to do.",
      );
      return;
    }
    setCapabilityError(null);
    onNext(data);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      {/* Capability selection replaces the legacy kind radio. Two
          independent booleans keep HYBRID as a natural consequence of
          checking both rather than a distinct top-level type. */}
      <div className="space-y-2">
        <Label>What does this organization do?</Label>
        <div className="grid grid-cols-1 gap-2">
          <label className="flex items-start gap-3 rounded-lg border border-zinc-200 p-3 cursor-pointer hover:border-zinc-300">
            <Checkbox
              checked={canSponsor}
              onCheckedChange={(v) => setValue("canSponsor", v === true)}
              className="mt-0.5"
            />
            <div>
              <p className="text-sm font-medium">Sponsor members</p>
              <p className="text-xs text-zinc-500">
                The organization pays for its members&apos; sessions. Creates a
                billing account.
              </p>
            </div>
          </label>
          {/* #863 — host capability only shown when ENABLE_HOST_ORGS is on.
              Hidden (not disabled) when off so the user can't tick a box the
              POST would reject with 400 HOST_ORGS_GATED. */}
          {hostOrgsEnabled && (
            <label className="flex items-start gap-3 rounded-lg border border-zinc-200 p-3 cursor-pointer hover:border-zinc-300">
              <Checkbox
                checked={canHost}
                onCheckedChange={(v) => setValue("canHost", v === true)}
                className="mt-0.5"
              />
              <div>
                <p className="text-sm font-medium">Host consultants</p>
                <p className="text-xs text-zinc-500">
                  The organization hosts consultants who deliver sessions.
                  Enables the payout account and rate cards. Admin verification
                  required before the first booking.
                </p>
              </div>
            </label>
          )}
        </div>
        {capabilityError && (
          <p className="text-sm text-red-500" role="alert">
            {capabilityError}
          </p>
        )}
        {/* Host-capable orgs are hard-gated server-side. If the
            ENABLE_HOST_ORGS flag is off on the target tenant, the
            create-org POST returns 400 HOST_ORGS_GATED and the
            wizard surfaces the friendly copy via the standard error
            humanization path (lib/labels/org-errors.ts). No inline
            banner — the server gate is the source of truth. */}
      </div>

      <div className="space-y-2">
        <Label htmlFor="name">Organization name *</Label>
        <Input id="name" {...register("name")} placeholder="Acme School" />
        {errors.name && (
          <p className="text-sm text-red-500">{errors.name.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="billingEmail">Billing email *</Label>
          {profileEmail && (
            <button
              type="button"
              onClick={() =>
                setValue(
                  "billingEmail",
                  usingProfileEmail ? "" : profileEmail,
                  { shouldValidate: true },
                )
              }
              className="text-xs text-zinc-500 hover:text-zinc-800 underline underline-offset-2 transition-colors"
            >
              {usingProfileEmail ? "Clear" : "Use my account email"}
            </button>
          )}
        </div>
        <Input
          id="billingEmail"
          type="email"
          {...register("billingEmail")}
          placeholder="billing@acme.edu"
        />
        {errors.billingEmail && (
          <p className="text-sm text-red-500">{errors.billingEmail.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <textarea
          id="description"
          {...register("description")}
          className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm min-h-20"
          placeholder="A short description of your organization"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Industry</Label>
          <Select
            value={watch("industry")}
            onValueChange={(v) => setValue("industry", v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select industry" />
            </SelectTrigger>
            <SelectContent>
              {INDUSTRIES.map((ind) => (
                <SelectItem key={ind} value={ind}>
                  {ind}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Size</Label>
          <Select
            value={watch("sizeBucket")}
            onValueChange={(v) => setValue("sizeBucket", v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select size" />
            </SelectTrigger>
            <SelectContent>
              {SIZE_BUCKETS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="website">Website</Label>
        <Input
          id="website"
          type="url"
          {...register("website")}
          placeholder="https://example.com"
        />
        {errors.website && (
          <p className="text-sm text-red-500">{errors.website.message}</p>
        )}
      </div>

      <div className="flex justify-between pt-4">
        {canGoBack ? (
          <Button
            type="button"
            variant="outline"
            onClick={onBack}
            disabled={isSubmitting}
          >
            Back
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Creating organization…" : "Next"}
        </Button>
      </div>
    </form>
  );
}
