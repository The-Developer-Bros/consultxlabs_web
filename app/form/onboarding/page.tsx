"use client";

import {
  updateOnboardingInformationAction,
  setOnboardingRoleAction,
  resetOnboardingRoleAction,
  completeOrgWorkspaceOnboardingAction,
} from "@/actions/forms/onboarding.action";
import {
  clearOnboardingDraftAction,
  loadOnboardingDraftAction,
  saveOnboardingDraftAction,
} from "@/actions/onboarding-draft.action";
import {
  createDraftSaveQueue,
  encodeDraftForSaveDetailed,
  type DraftSaveQueue,
} from "@/utils/onboarding-draft";
import { trackOnboardingEvent } from "@/utils/onboarding-telemetry";
import {
  OnboardingFormData,
  OnboardingFormDataSchema,
  transformOnboardingFormToServerData,
} from "@/utils/onboarding";
import { AlertTriangle, Check, History, LogOut, RotateCcw } from "lucide-react";
import { cn } from "@/utils/tailwind";
import { useToast } from "@/hooks/use-toast";
import { signOut, useSession } from "@/lib/auth-client";
import {
  getPendingReferral,
  clearPendingReferral,
} from "@/lib/pending-referral";
import { safeSameOriginPath } from "@/lib/safe-callback-url";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
// Step 0 stays eager — every user sees Personal Info first.
import PersonalInfoAndRoleForm from "./components/PersonalInfoAndRoleForm";

// Later steps + org wizard are code-split so the initial onboarding chunk
// does not pay for schedule UI, review forms, or the create-org wizard.
//
// Every split step needs `loading` — next/dynamic renders null while the chunk
// downloads, so without it pressing Next collapses the card to zero height and
// reads as a frozen app on a slow connection. The options object is repeated
// inline rather than hoisted to a shared const because SWC statically analyses
// it: a variable fails the build with "next/dynamic options must be an object
// literal".
function StepLoading() {
  return (
    <div className="flex items-center justify-center min-h-[240px]">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
      <span className="sr-only">Loading this step…</span>
    </div>
  );
}

const ConsultantPreferredScheduleForm = dynamic(
  () => import("./components/ConsultantPreferredScheduleForm"),
  { ssr: false, loading: () => <StepLoading /> },
);
const ConsultantProfessionalStep = dynamic(
  () => import("./components/ConsultantProfessionalStep"),
  { ssr: false, loading: () => <StepLoading /> },
);
const ConsultantAgreementAndVerificationStep = dynamic(
  () => import("./components/ConsultantAgreementAndVerificationStep"),
  { ssr: false, loading: () => <StepLoading /> },
);
const ConsultantReviewForm = dynamic(
  () => import("./components/ConsultantReviewForm"),
  { ssr: false, loading: () => <StepLoading /> },
);
const ConsulteeAgreementForm = dynamic(
  () => import("./components/ConsulteeAgreementForm"),
  { ssr: false, loading: () => <StepLoading /> },
);
const StaffAgreementForm = dynamic(
  () => import("./components/StaffAgreementForm"),
  { ssr: false, loading: () => <StepLoading /> },
);
const StaffProfileForm = dynamic(
  () => import("./components/StaffProfileForm"),
  { ssr: false, loading: () => <StepLoading /> },
);
const StaffReviewForm = dynamic(() => import("./components/StaffReviewForm"), {
  ssr: false,
  loading: () => <StepLoading />,
});
const CreateOrganizationWizard = dynamic(
  () =>
    import("@/components/organization/create-wizard/Wizard").then((m) => ({
      default: m.CreateOrganizationWizard,
    })),
  { ssr: false, loading: () => <StepLoading /> },
);

// ---------------------------------------------------------------------------
// Step registry
// ---------------------------------------------------------------------------

/**
 * Everything a step can need from the shell. The step forms were written
 * independently and take different props (`onNext`/`initialData` vs
 * `onSubmit`/`formData`/`onGoToStep`), so each entry adapts this context to its
 * own component instead of a single prop contract being forced on all of them.
 */
interface OnboardingStepContext {
  formData: Partial<OnboardingFormData>;
  userId?: string;
  onNext: (data: Partial<OnboardingFormData>) => Promise<void>;
  onBack: () => void;
  onSubmit: (data: Partial<OnboardingFormData>) => Promise<void>;
  onGoToStep: (targetStep: number) => void;
  onExitOrgWizard: () => void;
  /** Settle in-flight draft saves before anything deletes the row. */
  onQuiesceDraftSaves: () => Promise<void>;
}

interface OnboardingStep {
  /** Shown in the progress stepper and as the card title. */
  label: string;
  render: (ctx: OnboardingStepContext) => React.ReactNode;
  /** Needs more horizontal room than the default 3xl card. */
  wide?: boolean;
  /**
   * Step paints its own full-page chrome, so the shell (header, stepper, card)
   * steps aside entirely rather than nesting one stepper inside another.
   */
  fullBleed?: boolean;
}

// Roles come from the onboarding schema's discriminated union rather than a
// hand-written list, so adding a branch there fails to compile here until it
// declares its steps.
type OnboardingRole = z.infer<typeof OnboardingFormDataSchema>["role"];

// Shared across every role: step 0 is where the role is picked, so it cannot be
// role-specific.
const personalInfoStep: OnboardingStep = {
  label: "Personal Info",
  render: (ctx) => (
    <PersonalInfoAndRoleForm onNext={ctx.onNext} initialData={ctx.formData} />
  ),
};

/**
 * The onboarding flow, per role. Order in the array IS the step order — indices
 * are never written down anywhere, which is what lets ORG_WORKSPACE be a normal
 * two-entry flow instead of a special case bolted onto the step machine.
 *
 * CONSULTEE is deliberately two screens (#onboarding-ux): demand-side users
 * reach marketplace value with one form + consent. Profile enrichment
 * (career stage, goals, about-me) is deferred to the consultee dashboard's
 * Settings tab and the lazy `ensureConsulteeProfile` path — the server payload
 * schema already treats every consultee profile field as optional.
 */
const ONBOARDING_STEPS: Record<OnboardingRole, OnboardingStep[]> = {
  CONSULTANT: [
    personalInfoStep,
    {
      label: "Professional Profile",
      render: (ctx) => (
        <ConsultantProfessionalStep
          onNext={ctx.onNext}
          onBack={ctx.onBack}
          initialData={ctx.formData}
          personalInfo={{
            name: ctx.formData.name ?? "",
            email: ctx.formData.email ?? "",
            phone: ctx.formData.phone,
            address: ctx.formData.address,
            onlineStatus: ctx.formData.onlineStatus ?? false,
            timezone: ctx.formData.timezone,
            onboardingCompleted: ctx.formData.onboardingCompleted ?? false,
            role: ctx.formData.role ?? "CONSULTANT",
            // #1132 — step 1 cannot be completed without a validated adult DOB,
            // so by the time this step renders the value is always present. The
            // fallback keeps the type honest without inventing an age.
            dateOfBirth: ctx.formData.dateOfBirth ?? new Date(0),
            emailVerified: ctx.formData.emailVerified,
            image: ctx.formData.image,
          }}
        />
      ),
    },
    {
      label: "Availability",
      // The weekly slot grid does not fit the default card width.
      wide: true,
      render: (ctx) => (
        <ConsultantPreferredScheduleForm
          onNext={ctx.onNext}
          onBack={ctx.onBack}
          initialData={ctx.formData}
        />
      ),
    },
    {
      label: "Agreement & Verification",
      render: (ctx) => (
        <ConsultantAgreementAndVerificationStep
          onNext={ctx.onNext}
          onBack={ctx.onBack}
          formData={ctx.formData}
        />
      ),
    },
    {
      label: "Review",
      render: (ctx) => (
        <ConsultantReviewForm
          onSubmit={ctx.onSubmit}
          onBack={ctx.onBack}
          formData={ctx.formData}
          onGoToStep={ctx.onGoToStep}
        />
      ),
    },
  ],
  CONSULTEE: [
    personalInfoStep,
    {
      label: "Agreement",
      render: (ctx) => (
        <ConsulteeAgreementForm
          onNext={(data) => ctx.onSubmit(data)}
          onBack={ctx.onBack}
          formData={ctx.formData}
        />
      ),
    },
  ],
  STAFF: [
    personalInfoStep,
    {
      label: "Role Details",
      render: (ctx) => (
        <StaffProfileForm
          onNext={ctx.onNext}
          onBack={ctx.onBack}
          initialData={ctx.formData}
        />
      ),
    },
    {
      label: "Agreement",
      render: (ctx) => (
        <StaffAgreementForm
          onNext={ctx.onNext}
          onBack={ctx.onBack}
          initialData={ctx.formData}
        />
      ),
    },
    {
      label: "Review",
      render: (ctx) => (
        <StaffReviewForm
          onSubmit={ctx.onSubmit}
          onBack={ctx.onBack}
          formData={ctx.formData}
          onGoToStep={ctx.onGoToStep}
        />
      ),
    },
  ],
  ORG_WORKSPACE: [
    personalInfoStep,
    {
      label: "Create Organization",
      // The shared wizard owns the remaining 5-6 screens (Org Info → Review)
      // and ships its own stepper and cards, so the onboarding shell would
      // otherwise render a stepper inside a stepper.
      fullBleed: true,
      render: (ctx) => (
        // #863 — hostOrgsEnabled defaults to false here (host capability
        // hidden), which is the honest state while ENABLE_HOST_ORGS is off.
        // This is a client component with no server parent to read the flag;
        // TODO(#863): thread the server flag when host orgs launch (e.g. a
        // server action or a server shell).
        <CreateOrganizationWizard
          onCancel={ctx.onExitOrgWizard}
          afterLaunch={async () => {
            const userId = ctx.userId;
            if (!userId) return;
            // Same invariant as the submit path: no save may land after the
            // draft row is deleted below.
            await ctx.onQuiesceDraftSaves();
            await completeOrgWorkspaceOnboardingAction(userId);
            await clearOnboardingDraftAction();
          }}
        />
      ),
    },
  ],
  // ADMIN exists in the onboarding schema union but is not self-selectable
  // (the role picker does not offer it and `setOnboardingRoleAction`'s
  // allowlist rejects it), so there are no admin step forms to register.
  ADMIN: [personalInfoStep],
};

/**
 * Pick the step registry for a role, defaulting to the consultee flow.
 *
 * `Object.hasOwn` rather than `role in ONBOARDING_STEPS`: `in` walks the
 * prototype chain, so "constructor", "toString" and "__proto__" all answer
 * true and yield an Object.prototype member instead of a step array — and the
 * resulting `steps.map(...)` throws during render, taking the "Start over"
 * button down with it.
 *
 * Kept as defence in depth now that the draft payload has a structural schema
 * (`OnboardingDraftPayloadSchema`). That schema strips poisoned KEYS at the
 * storage boundary, but `role` is a legitimate key whose VALUE stays
 * deliberately untyped — a draft holds answers that are not yet valid — so
 * `role: "__proto__"` remains expressible and this guard remains the thing
 * that stops it. It also covers the value arriving from anywhere but a draft.
 */
function resolveRegistryRole(role: unknown): OnboardingRole {
  return typeof role === "string" && Object.hasOwn(ONBOARDING_STEPS, role)
    ? (role as OnboardingRole)
    : "CONSULTEE";
}

/** Autosave debounce for wizard drafts.
 *
 *  NOTE: `formData` only changes on a STEP TRANSITION — react-hook-form owns
 *  intra-step state and `setFormData` is called from `handleNext`, not on
 *  keystrokes. So this debounce coalesces rapid Next/Back clicks, not typing,
 *  and a step's contents are persisted when the user advances out of it.
 *  The pagehide flush below covers the window between the click and the
 *  timer firing. */
const DRAFT_SAVE_DEBOUNCE_MS = 800;

/**
 * Payload key → the words the user sees on the form. Only the fields that can
 * realistically dominate a 64KB payload are listed; anything else falls back
 * to generic wording rather than leaking an internal key name into the UI.
 */
const DRAFT_FIELD_LABELS: Record<string, string> = {
  aboutMe: "“About me” summary",
  achievements: "achievements",
  bio: "short bio",
  certificationsList: "certifications",
  customSlots: "custom availability",
  description: "expertise summary",
  educationHistory: "education entries",
  mentoringStyle: "mentoring style",
  qualifications: "qualifications",
  specialization: "specialization",
  verificationDocuments: "verification documents",
  verificationNotes: "verification notes",
  weeklySlots: "weekly availability",
  workExperiences: "work experience entries",
};

/** `Object.hasOwn` for the same reason as `resolveRegistryRole`: the key comes
 *  from a stored payload, and `in` would happily resolve "toString". */
function describeDraftField(field: string | null): string {
  return field && Object.hasOwn(DRAFT_FIELD_LABELS, field)
    ? DRAFT_FIELD_LABELS[field]
    : "longest answers";
}

const MultiStepForm: React.FC = () => {
  const { data: session } = useSession();
  const [step, setStep] = useState(0);
  const [formData, setFormData] = useState<Partial<OnboardingFormData>>({});
  const [draftRestored, setDraftRestored] = useState(false);
  // The stored draft existed but could not be restored (wizard version bump or
  // a corrupt row). Silence here reads as data loss, so it gets its own banner.
  const [draftQuarantined, setDraftQuarantined] = useState(false);
  // Autosave has stopped because the payload outgrew the column budget. Sticky
  // by nature — every later save fails the same way until something shrinks.
  const [draftOverBudgetField, setDraftOverBudgetField] = useState<
    string | null
  >(null);
  const [draftOverBudget, setDraftOverBudget] = useState(false);
  const router = useRouter();
  const { toast } = useToast();

  // Refs gate side effects across renders without re-triggering them:
  //  - draftReadyRef: autosave must not run until hydration resolved, or an
  //    empty mount-time state would overwrite the stored draft.
  //  - draftCompletedRef: once onboarding succeeds (or the user starts over),
  //    stop saving; the row is being deleted server-side.
  const draftReadyRef = useRef(false);
  const draftCompletedRef = useRef(false);
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest step/state for the pagehide flush, which must read current values
  // without re-registering its listener on every keystroke-free re-render.
  const stepRef = useRef(0);
  const formDataRef = useRef<Partial<OnboardingFormData>>({});
  // Serialized saves (review round 1): a later keystroke must land after an
  // earlier in-flight upsert, and the row must never be deleted while a save
  // is still unsettled — otherwise the upsert recreates it after the clear.
  const draftSaveQueueRef = useRef<DraftSaveQueue | null>(null);
  if (!draftSaveQueueRef.current) {
    draftSaveQueueRef.current = createDraftSaveQueue();
  }

  // Apply a referral code captured at first touch (signup / r/[code]) now that
  // the user is authenticated — covers OAuth and verified-email signups, which
  // no longer apply it at signup. Idempotent server-side (referredUserId is
  // unique), best-effort. #880
  useEffect(() => {
    if (!session?.user?.id) return;
    const code = getPendingReferral();
    if (!code) return;
    // Keep the code until a definitive outcome: clear on success or a terminal
    // 400 (invalid / already-referred / self-referral), but retain it on
    // transient failures (network / 429 / 5xx) so a later authenticated render
    // can retry rather than permanently losing attribution. #880
    fetch("/api/referrals/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
      .then((res) => {
        if (res.ok || res.status === 400) clearPendingReferral();
      })
      .catch(() => {});
  }, [session?.user?.id]);

  // Hydrate the resumable draft once per session identity. Runs after the
  // guard layout has confirmed this user still needs onboarding, so any
  // stored draft belongs to an unfinished run by construction.
  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      let result: Awaited<ReturnType<typeof loadOnboardingDraftAction>>;
      try {
        result = await loadOnboardingDraftAction();
      } catch {
        // Autosave must arm even when the read fails, or one transient error
        // disables saving for the whole session (the effect has [] deps, so
        // there is no second chance). Losing the RESTORE is acceptable;
        // losing every subsequent SAVE is not.
        if (!cancelled) draftReadyRef.current = true;
        trackOnboardingEvent("draft_load_failed", { reason: "threw" });
        return;
      }
      if (cancelled) return;
      draftReadyRef.current = true;
      if (!result.success) {
        trackOnboardingEvent("draft_load_failed", { reason: "action_error" });
        return;
      }
      if (!result.draft) return;
      const { payload, currentStep, role, quarantined } = result.draft;
      // A quarantined draft is the one case where "nothing restored" is not
      // the same as "nothing was ever saved". Say so: the user typed those
      // answers and is entitled to know they are not coming back.
      if (quarantined) {
        setDraftQuarantined(true);
        trackOnboardingEvent("draft_quarantined", { currentStep, role });
        return;
      }
      const hasPayload = Object.keys(payload).length > 0;
      if (!hasPayload && !(role && currentStep > 0)) return;
      // Whatever the user has already committed (a step-0 submit that beat this
      // load) still outranks the stored draft. Read it from the latest-value
      // ref, which is assigned during render: a functional `setFormData` would
      // not give us the merged result synchronously, and this effect needs the
      // effective role NOW to clamp the step against the right registry.
      const merged = {
        ...payload,
        ...formDataRef.current,
      } as Partial<OnboardingFormData>;
      setFormData(merged);
      // Clamp against the registry the RENDER will actually select, which
      // reads formData.role (the payload), not the stored column. The two can
      // disagree — the merge above lets an in-flight step-0 submit win over a
      // slower load — and clamping against the wrong one produces a step index
      // past the end of the rendered registry ("Step 5 of 2", blank body).
      //
      // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so a stored
      // role of "constructor"/"toString"/"__proto__" would pass and hand back
      // an Object.prototype member instead of a step array — `steps.map(...)`
      // then throws during render, and "Start over" lives inside the subtree
      // that threw, so the wizard cannot be recovered from the UI.
      const effectiveRole = resolveRegistryRole(merged.role);
      const registry = ONBOARDING_STEPS[effectiveRole];
      if (currentStep > 0) {
        setStep(Math.max(0, Math.min(currentStep, registry.length - 1)));
      }
      if (currentStep > 0 || hasPayload) setDraftRestored(true);
      trackOnboardingEvent("draft_restored", { currentStep, role });
    }
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  // The one place a draft snapshot is dispatched. Shared by the debounce timer
  // and the pagehide flush so both go through the same sanitize/gate/queue path.
  const dispatchDraftSave = useCallback(
    (snapshotStep: number, snapshot: Partial<OnboardingFormData>) => {
      const queue = draftSaveQueueRef.current;
      if (!queue) return;
      const prepared = encodeDraftForSaveDetailed({
        role: snapshot.role ?? null,
        currentStep: snapshotStep,
        payload: snapshot as Record<string, unknown>,
      });
      // Skipping stays non-fatal, but it is no longer silent. OVER_BUDGET in
      // particular is sticky: once the payload crosses the cap every later
      // save is a no-op while the resume banner still promises saved progress.
      // A Sentry breadcrumb tells US; the banner below tells the person who
      // can actually do something about it.
      if (!prepared.ok) {
        trackOnboardingEvent("draft_save_skipped", {
          reason: prepared.reason,
          bytes: prepared.bytes ?? null,
          currentStep: snapshotStep,
        });
        if (prepared.reason === "OVER_BUDGET") {
          setDraftOverBudgetField(prepared.largestField ?? null);
          setDraftOverBudget(true);
        }
        return;
      }
      // Back under budget — the user trimmed something, so stop warning.
      setDraftOverBudget(false);
      const encoded = prepared.value;
      void queue
        .enqueue(() => saveOnboardingDraftAction(encoded))
        .then((result) => {
          if (!result.success) {
            trackOnboardingEvent("draft_save_failed", { error: result.error });
          }
        })
        .catch(() => {
          trackOnboardingEvent("draft_save_failed", { error: "unreachable" });
        });
    },
    [],
  );

  stepRef.current = step;
  formDataRef.current = formData;

  // Autosave: debounce every step/data transition into a single upsert.
  useEffect(() => {
    if (!draftReadyRef.current || draftCompletedRef.current) return;
    if (!session?.user?.id) return;

    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      draftSaveTimerRef.current = null;
      dispatchDraftSave(step, formData);
    }, DRAFT_SAVE_DEBOUNCE_MS);

    return () => {
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    };
  }, [step, formData, session?.user?.id, dispatchDraftSave]);

  // Flush a pending save when the page is being hidden or torn down.
  //
  // Without this, the debounce window after a Next click is simply lost if the
  // user closes the tab inside it. This does not make delivery guaranteed —
  // a server action is a normal fetch and the browser may abandon it during
  // unload — but firing immediately is strictly better than a certain loss.
  // `pagehide` (not `beforeunload`) because bfcache and iOS Safari only fire
  // the former; `visibilitychange` catches tab-switches and app backgrounding.
  useEffect(() => {
    if (!session?.user?.id) return;
    const flush = () => {
      if (!draftReadyRef.current || draftCompletedRef.current) return;
      if (!draftSaveTimerRef.current) return; // nothing pending
      clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
      dispatchDraftSave(stepRef.current, formDataRef.current);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [session?.user?.id, dispatchDraftSave]);

  /** Cancel pending autosave and let every dispatched-but-unsettled save land
   *  BEFORE the caller deletes the draft row — an upsert arriving after the
   *  delete would resurrect stale state (review round 1). */
  const quiesceDraftSaves = async () => {
    draftCompletedRef.current = true;
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    await draftSaveQueueRef.current?.drain().catch(() => {});
  };

  const startOver = async () => {
    await quiesceDraftSaves();
    setDraftRestored(false);
    // Both warnings describe the draft being discarded here, so neither can
    // outlive it.
    setDraftQuarantined(false);
    setDraftOverBudget(false);
    setFormData({});
    setStep(0);
    await clearOnboardingDraftAction().catch(() => {});
    // Autosave must stay armed: hydration runs once per mount, so resetting
    // draftReadyRef here would kill saving for the rest of the session
    // (review round 1). draftCompletedRef stayed true through the reset
    // above, so the empty reset state itself was never persisted.
    draftCompletedRef.current = false;
  };

  const handleNext = async (stepData: Partial<OnboardingFormData>) => {
    // Merge new data first so the async role-flip below reads the
    // freshest values (React setState batching would otherwise give us
    // stale formData).
    const merged: Partial<OnboardingFormData> = { ...formData, ...stepData };
    if (stepData.scheduleType) {
      merged.scheduleType = stepData.scheduleType;
      if (stepData.weeklySlots) {
        merged.weeklySlots = [...stepData.weeklySlots];
      }
      if (stepData.customSlots) {
        merged.customSlots = [...stepData.customSlots];
      }
    }
    setFormData(merged);
    trackOnboardingEvent("step_advance", {
      fromStep: step,
      role: merged.role ?? null,
    });

    // ORG_WORKSPACE handoff: when the user completes Personal Info we commit
    // their role on the User row so the wizard step's
    // `POST /api/organizations` authorizes — the API gate requires
    // `UserRole === "ORG_WORKSPACE"` and the signup default is CONSULTEE.
    // Backing out of the wizard reverts it (see `handleExitOrgWizard`).
    if (step === 0 && merged.role === "ORG_WORKSPACE") {
      const userId = session?.user?.id;
      if (!userId) {
        toast({
          title: "Session Expired",
          description: "Please sign in again to continue.",
          variant: "destructive",
        });
        signOut();
        return;
      }
      // Controlled inputs surface blanks as "" — coerce to undefined so the
      // action's Zod validator (which rejects "" to avoid colliding on the
      // `User.phone @unique` index) sees the field as truly omitted.
      const trimmedPhone = merged.phone?.trim();
      const result = await setOnboardingRoleAction(userId, "ORG_WORKSPACE", {
        name: merged.name?.trim() || undefined,
        phone: trimmedPhone || undefined,
        timezone: merged.timezone?.trim() || undefined,
      });
      if (!result.success) {
        toast({
          title: "Unable to continue",
          description: result.error ?? "Please try again.",
          variant: "destructive",
        });
        return;
      }
    }

    setStep((prevStep) => prevStep + 1);
  };

  const handleBack = () => {
    trackOnboardingEvent("step_back", { fromStep: step });
    setStep((prevStep) => prevStep - 1);
  };

  const handleGoToStep = (targetStep: number) => {
    setStep(targetStep);
  };

  // Backing out of the create-org wizard must also undo the role we committed
  // on the way in, otherwise a user who changes their mind is left on
  // ORG_WORKSPACE with `onboardingCompleted: false` — able to create orgs
  // without ever having finished onboarding. Best-effort and fire-and-forget:
  // returning to step 0 is the user-visible action, and the server no-ops
  // unless the handoff is still provisional. Re-picking ORG_WORKSPACE
  // re-commits the role through `handleNext`.
  const handleExitOrgWizard = () => {
    setStep(0);
    const userId = session?.user?.id;
    if (!userId) return;
    void resetOnboardingRoleAction(userId);
  };

  const handleSubmit = async (data: Partial<OnboardingFormData>) => {
    const finalData = { ...formData, ...data };

    try {
      const id = session?.user?.id;
      if (!id) {
        toast({
          title: "Session Expired",
          description: "Please sign in again to continue.",
          variant: "destructive",
        });
        signOut();
        return;
      }

      // Validate the form data
      const validationResult = OnboardingFormDataSchema.safeParse(finalData);
      if (!validationResult.success) {
        const errors = validationResult.error.errors;
        const fieldErrors = errors.map((e) => e.path.join(" > ")).join(", ");

        toast({
          title: "Please Complete Required Fields",
          description: `Missing or invalid: ${fieldErrors}`,
          variant: "destructive",
        });

        console.warn("Form validation errors:", errors);
        return;
      }

      // Transform the data for server submission
      // Cast needed: OnboardingFormDataSchema is a discriminated union (role-specific output),
      // while OnboardingFormData is an intersection (all fields). The union output satisfies
      // the intersection at runtime (one branch is fully populated) but TS can't prove it.
      const validated = validationResult.data as OnboardingFormData;
      const requestBody = {
        ...transformOnboardingFormToServerData(validated),
        // Include professional background fields (not part of OnboardingData schema)
        workExperiences: validated.workExperiences,
        educationHistory: validated.educationHistory,
        certificationsList: validated.certificationsList,
        achievements: validated.achievements,
      };

      toast({
        title: "Saving Your Profile",
        description: "Please wait while we set up your account...",
      });

      const result = await updateOnboardingInformationAction(id, requestBody);

      if (!result.success || !result.user) {
        const errorMessage =
          result.error ?? "Failed to save your profile. Please try again.";

        if (errorMessage.includes("User not found")) {
          toast({
            title: "Account Not Found",
            description: "Your session has expired. Please sign in again.",
            variant: "destructive",
          });
          signOut();
          return;
        }

        trackOnboardingEvent("submit_error", { error: errorMessage });
        toast({
          title: "Unable to Save Profile",
          description: errorMessage,
          variant: "destructive",
        });
        return;
      }

      // Success: stop autosaving and drop the draft — the terminal CAS flip
      // has happened server-side, and a lingering row would resurrect stale
      // state for any future re-onboarding surface. Drain first so no already
      // dispatched save can recreate the row after deletion (review round 1).
      draftCompletedRef.current = true;
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
      void draftSaveQueueRef.current
        ?.drain()
        .catch(() => {})
        .then(() => clearOnboardingDraftAction())
        .catch(() => {});

      if (result.verificationWarning) {
        toast({
          title: "Profile Saved — Verification Issue",
          description: result.verificationWarning as string,
          variant: "destructive",
        });
      } else if (
        finalData.role === "CONSULTANT" &&
        result.verificationDeferred
      ) {
        trackOnboardingEvent("verification_deferred", {});
        toast({
          title: "Profile Submitted!",
          description:
            "Add your LinkedIn URL and one document from Settings to get verified — your profile is saved and you can explore the dashboard meanwhile.",
        });
      } else if (finalData.role === "CONSULTANT") {
        toast({
          title: "Profile Submitted!",
          description:
            "Your verification is under review (1-2 business days). You can start setting up your consultation plans while you wait.",
        });
      } else if (finalData.role === "CONSULTEE") {
        toast({
          title: "Welcome to Familiarise!",
          description:
            "Your profile is ready. Browse our expert directory to book your first session.",
        });
      } else {
        toast({
          title: "Welcome to Familiarise!",
          description: "Your profile has been created successfully.",
        });
      }

      trackOnboardingEvent("submit_success", {
        role: finalData.role ?? null,
        verificationDeferred: Boolean(result.verificationDeferred),
      });

      // E2E-audit fix — callbackUrl FIRST, and the stashed invite token is
      // consumed unconditionally. Previously the token was checked first with
      // no TTL: clicking an org invite once, then weeks later signing up via
      // "Book now" (callbackUrl = checkout URL), diverted the completed
      // onboarding to a likely-expired invite instead of the checkout. An
      // explicit deep link always outranks a stale side-effect; the redirect
      // also now uses the hardened same-origin validator.
      const callbackUrlParam = new URLSearchParams(window.location.search).get(
        "callbackUrl",
      );
      const safeCallback = safeSameOriginPath(callbackUrlParam);

      const pendingToken =
        typeof window !== "undefined"
          ? localStorage.getItem("pendingOrgInviteToken")
          : null;
      if (pendingToken) {
        localStorage.removeItem("pendingOrgInviteToken");
      }

      if (safeCallback) {
        router.push(safeCallback);
        return;
      }

      if (pendingToken) {
        router.push(`/organizations/invite/${pendingToken}`);
        return;
      }

      // ORG_WORKSPACE flow never reaches this handler — the shared
      // CreateOrganizationWizard's Review step owns the finalize +
      // redirect via `completeOrgWorkspaceOnboardingAction`.

      // Redirect based on role (server has already updated the user record,
      // session cookie will refresh automatically)
      if (finalData.role === "CONSULTANT" && result.user.consultantProfileId) {
        router.push(`/dashboard/consultant/${result.user.consultantProfileId}`);
      } else if (
        finalData.role === "CONSULTEE" &&
        result.user.consulteeProfileId
      ) {
        router.push(`/dashboard/consultee/${result.user.consulteeProfileId}`);
      } else if (finalData.role === "STAFF" && result.user.staffProfileId) {
        router.push(`/dashboard/staff/${result.user.staffProfileId}`);
      } else {
        router.push("/dashboard");
      }
    } catch (error: unknown) {
      trackOnboardingEvent("submit_error", { error: "unhandled_exception" });
      console.error("Error during onboarding:", error);
      toast({
        title: "Something Went Wrong",
        description:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred. Please try again.",
        variant: "destructive",
      });
    }
  };

  // `role` is only trustworthy once step 0 has been submitted; before that (and
  // for anything the registry does not cover) the consultee flow is the
  // default, as it was when the labels lived in their own map.
  const currentRole: OnboardingRole = resolveRegistryRole(formData.role);
  const steps = ONBOARDING_STEPS[currentRole];
  const totalSteps = steps.length;
  const activeStep = steps[step];

  const stepContext: OnboardingStepContext = {
    formData,
    userId: session?.user?.id,
    onNext: handleNext,
    onBack: handleBack,
    onSubmit: handleSubmit,
    onGoToStep: handleGoToStep,
    onExitOrgWizard: handleExitOrgWizard,
    onQuiesceDraftSaves: quiesceDraftSaves,
  };

  if (activeStep?.fullBleed) {
    return <>{activeStep.render(stepContext)}</>;
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-muted to-background dark:from-gray-900 dark:to-gray-950">
      {/* Header */}
      <header className="border-b bg-card/80 dark:bg-gray-900/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <svg
                className="w-5 h-5 text-primary-foreground"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
            </div>
            <span className="text-xl font-semibold truncate">Familiarise</span>
          </div>
          <div className="flex items-center gap-3 sm:gap-4 shrink-0">
            <span className="text-sm text-muted-foreground">
              Step {step + 1} of {totalSteps}
            </span>
            <button
              onClick={() =>
                signOut({
                  fetchOptions: {
                    onSuccess: () => {
                      window.location.href = "/";
                    },
                  },
                })
              }
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              title="Sign out"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main
        className={`container mx-auto px-4 py-8 ${activeStep?.wide ? "max-w-[80%]" : "max-w-3xl"}`}
      >
        {/* Resume banner — shown once when a saved draft was restored */}
        {draftRestored && (
          <div className="mb-6 flex items-center justify-between gap-4 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              <History className="h-4 w-4 shrink-0 text-primary" />
              <span className="text-foreground">
                Welcome back — we saved your progress.
              </span>
            </div>
            <button
              onClick={() => void startOver()}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0"
              title="Discard saved progress and start from the beginning"
            >
              <RotateCcw className="w-4 h-4" />
              Start over
            </button>
          </div>
        )}

        {/* Draft could not be restored — the stored answers are gone, and
            saying nothing would read as the wizard losing them silently. */}
        {draftQuarantined && (
          <div className="mb-6 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
            <span className="text-foreground">
              This form has changed since you last saved, so we couldn&apos;t
              restore your earlier answers. You may need to enter some of them
              again — everything from here on is being saved as normal.
            </span>
          </div>
        )}

        {/* Autosave has stopped because the draft outgrew its storage budget.
            Deliberately non-blocking: the submit path has its own, larger
            limits, so the run can still be finished — only RESUMING it later
            is at risk. */}
        {draftOverBudget && (
          <div className="mb-6 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
            <span className="text-foreground">
              Your answers are too long for us to save your progress, so this
              run won&apos;t be here if you come back later. Shortening your{" "}
              <strong className="font-medium">
                {describeDraftField(draftOverBudgetField)}
              </strong>{" "}
              will start it saving again. You can still finish and submit
              without changing anything.
            </span>
          </div>
        )}

        {/* Progress Stepper */}
        <div className="flex items-start justify-between mb-8">
          {steps.map(({ label }, index) => (
            <React.Fragment key={label}>
              {/* Step circle + label */}
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
                  {label}
                </span>
              </div>
              {/* Connector line */}
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

        {/* Form Card */}
        <Card className="shadow-lg">
          <CardHeader className="text-center pb-2">
            <CardTitle className="text-fluid-2xl tracking-tight">
              {step === 0 ? "Welcome! Let's get started" : activeStep?.label}
            </CardTitle>
            <p className="text-muted-foreground text-sm mt-1">
              {step === 0
                ? "Tell us a bit about yourself. You can always update this later."
                : "Complete the information below to continue."}
            </p>
          </CardHeader>
          <CardContent className="pt-6">
            {activeStep?.render(stepContext)}
          </CardContent>
        </Card>

        {/* Help Text */}
        <p className="text-center text-sm text-muted-foreground mt-6">
          Need help?{" "}
          <a href="/support" className="text-primary hover:underline">
            Contact support
          </a>
        </p>
      </main>
    </div>
  );
};

export default MultiStepForm;
