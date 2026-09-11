"use client";

import React, { useState } from "react";
import Link from "next/link";
import { Check, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/utils/tailwind";

import { getSteps } from "./types";
import type { OrgWizardData } from "./types";
import { OrgInfoStep } from "./OrgInfoStep";
import { BillingStep } from "./BillingStep";
import { RevenueRatesStep } from "./RevenueRatesStep";
import { BrandingStep } from "./BrandingStep";
import { InviteTeamStep } from "./InviteTeamStep";
import { ReviewStep } from "./ReviewStep";

export interface CreateOrganizationWizardProps {
  /**
   * Where the "Familiarise" brand link and the Cancel button point. When
   * omitted the brand + cancel controls are hidden — used by the onboarding
   * caller, which has its own header and has already passed the point of
   * no-return (the User row exists and the role is committed).
   */
  cancelHref?: string;
  /**
   * Called when the user hits Back on the first wizard step (Org Info).
   * The onboarding caller uses this to pop back to the role picker so the
   * user can change their mind — the dashboard caller leaves it undefined
   * and relies on `cancelHref` instead.
   */
  onCancel?: () => void;
  /**
   * Called after the wizard's final Review step finishes. The onboarding
   * caller uses this to mark `user.onboardingCompleted = true`.
   */
  afterLaunch?: (orgId: string) => Promise<void> | void;
  /** Override the post-launch redirect target. */
  finalRedirectPath?: (orgId: string) => string;
  /**
   * #863 — whether host orgs are enabled (ENABLE_HOST_ORGS). The flag is
   * server-only, so the render sites read it and pass it here; OrgInfoStep
   * hides the "Host consultants" capability when false so a user can't tick a
   * box the POST would only reject with 400 HOST_ORGS_GATED.
   */
  hostOrgsEnabled?: boolean;
}

export function CreateOrganizationWizard({
  cancelHref,
  onCancel,
  afterLaunch,
  finalRedirectPath,
  hostOrgsEnabled = false,
}: CreateOrganizationWizardProps = {}) {
  const [step, setStep] = useState(0);
  const [wizardData, setWizardData] = useState<Partial<OrgWizardData>>({});
  // Retained for backwards compatibility with `stepProps.isSubmitting`; the
  // final POST now happens in ReviewStep, so no mid-flight submits here.
  const [isSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Steps are recomputed whenever capabilities change so the stepper only
  // renders the billing/rate-card steps when the org actually sponsors/hosts.
  // An org with `canSponsor=false, canHost=false` is a configuration error;
  // OrgInfoStep rejects it before `handleNext` fires.
  const steps = getSteps({
    canSponsor: wizardData.canSponsor ?? true,
    canHost: wizardData.canHost ?? false,
  });

  // Org creation is deferred to the Review step. Earlier steps are pure
  // state mutations on `wizardData` — that avoids orphan Organization rows
  // if a user drops out mid-wizard and makes the "Create Organization"
  // action happen at the point the user actually commits (review), not on
  // step 1. See docs/onboarding/onboarding-system-reference.md.
  const handleNext = (stepData: Partial<OrgWizardData>) => {
    setCreateError(null);
    setWizardData((prev) => ({ ...prev, ...stepData }));
    setStep((s) => Math.min(s + 1, steps.length - 1));
  };

  // On step 0, "Back" exits the wizard via `onCancel` (onboarding caller
  // uses this to return to the role picker). Subsequent steps just
  // decrement within the wizard.
  const handleBack = () => {
    if (step === 0) {
      onCancel?.();
      return;
    }
    setStep((s) => Math.max(s - 1, 0));
  };
  const handleGoToStep = (target: number) => setStep(target);

  const stepProps = {
    onNext: handleNext,
    onBack: handleBack,
    onGoToStep: handleGoToStep,
    initialData: wizardData,
    isSubmitting,
    afterLaunch,
    finalRedirectPath,
    // Expose whether Back is meaningful on this step. OrgInfoStep reads
    // this to decide if its Back button should render.
    canGoBack: step > 0 || !!onCancel,
    // #863 — OrgInfoStep hides the host capability when host orgs are off.
    hostOrgsEnabled,
  };

  const currentStep = steps[step];

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Header */}
      {cancelHref && (
        <header className="sticky top-0 z-40 bg-white/80 backdrop-blur-xl border-b border-zinc-200/50">
          <div className="container mx-auto px-4 py-4 flex items-center justify-between max-w-3xl">
            <Link
              href={cancelHref}
              className="text-sm font-semibold text-zinc-900 hover:text-zinc-700"
            >
              Familiarise
            </Link>
            <div className="flex items-center gap-4">
              <span className="text-sm text-zinc-500">
                Step {step + 1} of {steps.length}
              </span>
              <Link
                href={cancelHref}
                className="flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 transition-colors"
                title="Cancel setup"
              >
                <X className="w-4 h-4" />
                <span className="hidden sm:inline">Cancel</span>
              </Link>
            </div>
          </div>
        </header>
      )}

      {/* Main content */}
      <main className="container mx-auto px-4 py-8 max-w-3xl">
        {/* Stepper */}
        <div className="flex items-start justify-between mb-8">
          {steps.map((s, index) => (
            <React.Fragment key={s.key}>
              <div className="flex flex-col items-center">
                <div
                  className={cn(
                    "w-9 h-9 rounded-full flex items-center justify-center text-sm font-medium border-2 transition-all",
                    index < step &&
                      "bg-primary border-primary text-primary-foreground",
                    index === step &&
                      "bg-primary border-primary text-primary-foreground ring-4 ring-primary/20",
                    index > step &&
                      "border-muted-foreground/30 text-muted-foreground",
                  )}
                >
                  {index < step ? <Check className="w-4 h-4" /> : index + 1}
                </div>
                <span
                  className={cn(
                    "text-xs mt-1.5 text-center max-w-[80px] truncate",
                    index <= step
                      ? "text-primary font-medium"
                      : "text-muted-foreground",
                  )}
                >
                  {s.label}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={cn(
                    "flex-1 h-0.5 mx-2 mt-[18px] transition-colors",
                    index < step ? "bg-primary" : "bg-muted-foreground/20",
                  )}
                />
              )}
            </React.Fragment>
          ))}
        </div>

        {/* Form card */}
        <Card className="shadow-lg">
          <CardHeader className="text-center pb-2">
            <CardTitle className="text-2xl">{currentStep.label}</CardTitle>
            <p className="text-muted-foreground text-sm mt-1">
              {currentStep.subtitle}
            </p>
          </CardHeader>
          <CardContent className="pt-4 pb-8 px-6 sm:px-8">
            {createError && (
              <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                {createError}
              </div>
            )}

            {currentStep.key === "org-info" && <OrgInfoStep {...stepProps} />}
            {currentStep.key === "billing" && <BillingStep {...stepProps} />}
            {currentStep.key === "revenue-rates" && (
              <RevenueRatesStep {...stepProps} />
            )}
            {currentStep.key === "branding" && <BrandingStep {...stepProps} />}
            {currentStep.key === "invite-team" && (
              <InviteTeamStep {...stepProps} />
            )}
            {currentStep.key === "review" && <ReviewStep {...stepProps} />}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
