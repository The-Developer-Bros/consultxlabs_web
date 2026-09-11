"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Building2, Pencil, Check, X, Loader2 } from "lucide-react";
import { z } from "zod";
import { getSteps } from "./types";
import type { StepProps } from "./types";
import {
  deriveCapabilityKind,
  CAPABILITY_LABEL,
  CAPABILITY_BADGE_CLASS,
  FUNDING_SOURCE_LABEL,
  FUNDING_SOURCE_BADGE_CLASS,
  MEMBER_ROLE_LABEL,
  narrowFundingSource,
  narrowSelfServiceRole,
} from "@/lib/labels/org-labels";
import {
  CreateOrganizationPayloadSchema,
  CreateOrganizationResponseSchema,
  PatchOrganizationPayloadSchema,
  CreateRateCardPayloadSchema,
  CreateInvitationPayloadSchema,
  CreateInvitationResponseSchema,
} from "@/schemas/organizations";
import {
  parseJsonResponse,
  validateOutboundPayload,
  ApiResponseError,
} from "@/lib/fetch-helpers";
import { humanizeOrgError } from "@/lib/labels/org-errors";

interface InviteResult {
  email: string;
  ok: boolean;
  error?: string;
}

/**
 * Shape of the `detail` field that our routes attach when a Zod schema
 * rejects an inbound body — `parsed.error.flatten()` from the server.
 * Modeled as a Zod schema (rather than an interface + `as` cast) so we
 * get a single safeParse instead of a chain of `typeof === "object"`
 * narrowings, and so a future server change to the detail shape fails
 * a typed parse instead of silently `as`-casting through `unknown`.
 */
const ZodFlattenedErrorSchema = z.object({
  fieldErrors: z.record(z.array(z.string())).optional(),
  formErrors: z.array(z.string()).optional(),
});

/**
 * Pull the first field-level message out of a Zod `.flatten()` envelope
 * so the Review step can show a useful inline message ("billingEmail:
 * Invalid email") instead of swallowing it behind a generic "Invalid
 * body". Returns `null` when `detail` doesn't match the Zod-flattened
 * shape so callers can fall through to a higher-level fallback.
 */
function extractFirstFieldError(detail: unknown): string | null {
  const parsed = ZodFlattenedErrorSchema.safeParse(detail);
  if (!parsed.success) return null;
  const { fieldErrors, formErrors } = parsed.data;
  if (fieldErrors) {
    for (const [field, msgs] of Object.entries(fieldErrors)) {
      const first = msgs[0];
      if (first) return `${field}: ${first}`;
    }
  }
  return formErrors?.[0] ?? null;
}

/**
 * Lift a launch-flow Error into user-facing copy. ApiResponseError
 * carries the structured detail so we can route through Zod-flattened
 * field errors first, then the humanised server message, then a final
 * fallback. Plain Errors (validation, network) surface verbatim.
 */
function describeLaunchError(err: unknown): string {
  if (err instanceof ApiResponseError) {
    const fieldMsg = extractFirstFieldError(err.detail);
    if (fieldMsg) return fieldMsg;
    return humanizeOrgError(err.message);
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}

// PATCH /api/organizations/[orgId] returns the updated org (or
// `{ ok: true }`); the wizard doesn't read the body, only `res.ok`.
// Passthrough schema lets parseJsonResponse own the success/error split
// instead of the previous bespoke fetch + json + cast triplet.
const PatchOrganizationResponseSchema = z.object({}).passthrough();

export function ReviewStep({
  onBack,
  onGoToStep,
  initialData,
  afterLaunch,
  finalRedirectPath,
}: StepProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [inviteResults, setInviteResults] = useState<InviteResult[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  // #1132 follow-up — launch is resumable within this mount. Creation is
  // deferred to this step precisely so mid-wizard drop-off writes nothing,
  // but that made a PARTIAL failure unrecoverable: the org row existed, a
  // retry re-POSTed the same slug, and the server's SLUG_TAKEN 409 stranded
  // a half-configured orphan with no path forward. Once POST succeeds the
  // id is pinned here and retries skip straight to the failed follow-up
  // step. (A full page reload still loses the pin — full cross-reload
  // resume would need a server-side draft, deliberately out of scope.)
  const createdOrgIdRef = useRef<string | null>(null);

  const emails = initialData.inviteEmails ?? [];
  const canSponsor = initialData.canSponsor ?? true;
  const canHost = initialData.canHost ?? false;
  const capability = deriveCapabilityKind(canSponsor, canHost);

  // Derive step indices from the same getSteps logic used in page.tsx
  const steps = getSteps({ canSponsor, canHost });
  const idx = (key: string) => steps.findIndex((s) => s.key === key);

  const handleLaunch = async () => {
    if (!initialData.name || !initialData.billingEmail) {
      setError("Missing organization name or billing email. Please go back to step 1.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      // Step 1 — create the organization. Deferred from step 0 of the
      // wizard so a user who drops out mid-flow doesn't leave an orphan
      // Organization row; the commitment happens here at launch.
      //
      // Validate the outbound body before opening the network connection —
      // catches malformed wizard state (missing email, name too long, etc)
      // before the server returns a generic 400.
      //
      // Idempotent on retry (#1132 follow-up): if a previous attempt already
      // created the org, resume from the step that failed instead of
      // re-POSTing into a permanent SLUG_TAKEN.
      let orgId = createdOrgIdRef.current;
      if (!orgId) {
        const createPayload = validateOutboundPayload(
          CreateOrganizationPayloadSchema,
          {
            name: initialData.name,
            billingEmail: initialData.billingEmail,
            canSponsor,
            canHost,
            description: initialData.description || undefined,
            industry: initialData.industry || undefined,
            sizeBucket: initialData.sizeBucket || undefined,
            website: initialData.website || undefined,
            ...(canSponsor
              ? {
                  fundingSource: initialData.fundingSource ?? "PERSONAL",
                  paymentTermsDays: initialData.paymentTermsDays ?? 60,
                }
              : {}),
          },
        );
        const createRes = await fetch("/api/organizations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createPayload),
        });
        const created = await parseJsonResponse(
          createRes,
          CreateOrganizationResponseSchema,
          "Failed to create organization",
        );
        orgId = created.organization.id;
        createdOrgIdRef.current = orgId;
      }

      // Step 2a — PATCH branding colors (org endpoint accepts these).
      const hasBranding =
        initialData.primaryColor != null ||
        initialData.secondaryColor != null;
      if (hasBranding) {
        const patchPayload = validateOutboundPayload(
          PatchOrganizationPayloadSchema,
          {
            primaryColor: initialData.primaryColor ?? null,
            secondaryColor: initialData.secondaryColor ?? null,
          },
        );
        const patchRes = await fetch(`/api/organizations/${orgId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patchPayload),
        });
        await parseJsonResponse(
          patchRes,
          PatchOrganizationResponseSchema,
          "Failed to save branding",
        );
      }

      // Step 2b — POST rate card for host orgs. Rate-card fields are owned
      // by /api/organizations/[orgId]/rate-cards, not the org PATCH route.
      const hasRateCard =
        canHost &&
        (initialData.platformBps != null ||
          initialData.orgBps != null ||
          initialData.consultantBps != null);
      if (hasRateCard) {
        const rateCardPayload = validateOutboundPayload(
          CreateRateCardPayloadSchema,
          {
            platformBps: initialData.platformBps ?? 1000,
            orgBps: initialData.orgBps ?? 1000,
            consultantBps: initialData.consultantBps ?? 8000,
          },
        );
        const rcRes = await fetch(
          `/api/organizations/${orgId}/rate-cards`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(rateCardPayload),
          },
        );
        await parseJsonResponse(
          rcRes,
          z.object({}).passthrough(),
          "Failed to save revenue split",
        );
      }

      // Step 3 — send invitations in parallel. Individual failures surface
      // via the per-row InviteResult without blocking launch.
      if (emails.length > 0) {
        const inviteRoleNarrowed = narrowSelfServiceRole(
          initialData.inviteRole,
        );
        const results = await Promise.allSettled(
          emails.map(async (email) => {
            const invitePayload = validateOutboundPayload(
              CreateInvitationPayloadSchema,
              { email, role: inviteRoleNarrowed },
            );
            const res = await fetch(
              `/api/organizations/${orgId}/invitations`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(invitePayload),
              },
            );
            await parseJsonResponse(
              res,
              CreateInvitationResponseSchema,
              `Failed to invite ${email}`,
            );
            return email;
          }),
        );

        const mapped: InviteResult[] = results.map((r, i) => ({
          email: emails[i],
          ok: r.status === "fulfilled",
          error:
            r.status === "rejected" ? describeLaunchError(r.reason) : undefined,
        }));
        setInviteResults(mapped);

        // Wait briefly to show results before navigating
        await new Promise((r) => setTimeout(r, 1500));
      }

      // Onboarding caller uses this to flip `user.onboardingCompleted`
      // atomically with the launch. We deliberately don't block the
      // redirect on failure: the org + invitations are already
      // persisted, and the user is much better served by landing on
      // their new dashboard than by being trapped on the Review screen
      // with a confusing error. The onboarding flag will be flipped on
      // the next dashboard load (or via a follow-up server action) and
      // the failure is captured in the console for ops.
      if (afterLaunch) {
        try {
          await afterLaunch(orgId);
        } catch (afterErr) {
          console.error(
            "afterLaunch hook failed — proceeding to dashboard anyway",
            afterErr,
          );
        }
      }

      const target = finalRedirectPath
        ? finalRedirectPath(orgId)
        : `/dashboard/organization/${orgId}/home`;
      router.push(target);
    } catch (err) {
      setError(describeLaunchError(err));
      setIsSubmitting(false);
    }
  };

  const Section = ({
    title,
    stepKey,
    children,
  }: {
    title: string;
    stepKey: string;
    children: React.ReactNode;
  }) => (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between py-3 px-4">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onGoToStep?.(idx(stepKey))}
          disabled={isSubmitting}
        >
          <Pencil className="h-3 w-3 mr-1" /> Edit
        </Button>
      </CardHeader>
      <CardContent className="px-4 pb-4 text-sm text-zinc-600 space-y-1">
        {children}
      </CardContent>
    </Card>
  );

  // Narrow through the Zod enums — same path the edit steps use — so
  // the review screen matches what the server will accept verbatim.
  const fundingSource = narrowFundingSource(initialData.fundingSource);
  const inviteRole = narrowSelfServiceRole(initialData.inviteRole);

  return (
    <div className="space-y-4">
      <Section title="Organization Info" stepKey="org-info">
        <p>
          <strong>Name:</strong> {initialData.name || "—"}
        </p>
        <p>
          <strong>Email:</strong> {initialData.billingEmail || "—"}
        </p>
        <div className="flex items-center gap-1">
          <strong>Capability:</strong>{" "}
          <Badge variant="secondary" className={CAPABILITY_BADGE_CLASS[capability]}>
            {CAPABILITY_LABEL[capability]}
          </Badge>
        </div>
        {initialData.description && (
          <p>
            <strong>Description:</strong> {initialData.description}
          </p>
        )}
        {initialData.industry && (
          <p>
            <strong>Industry:</strong> {initialData.industry}
          </p>
        )}
        {initialData.sizeBucket && (
          <p>
            <strong>Size:</strong>{" "}
            {initialData.sizeBucket.replace(/_/g, " ").toLowerCase()}
          </p>
        )}
        {initialData.website && (
          <p>
            <strong>Website:</strong> {initialData.website}
          </p>
        )}
      </Section>

      {canSponsor && (
        <Section title="Billing" stepKey="billing">
          <div className="flex items-center gap-2">
            <strong>Funding:</strong>{" "}
            <Badge
              variant="secondary"
              className={FUNDING_SOURCE_BADGE_CLASS[fundingSource]}
            >
              {FUNDING_SOURCE_LABEL[fundingSource]}
            </Badge>
          </div>
          {fundingSource === "INVOICE" && (
            <p>
              <strong>Payment terms:</strong> NET-
              {initialData.paymentTermsDays ?? 60}
            </p>
          )}
        </Section>
      )}

      {canHost && (
        <Section title="Revenue Rates" stepKey="revenue-rates">
          <p>
            <strong>Platform:</strong>{" "}
            {((initialData.platformBps ?? 1000) / 100).toFixed(2)}%
          </p>
          <p>
            <strong>Organization:</strong>{" "}
            {((initialData.orgBps ?? 1000) / 100).toFixed(2)}%
          </p>
          <p>
            <strong>Consultant:</strong>{" "}
            {((initialData.consultantBps ?? 8000) / 100).toFixed(2)}%
          </p>
          <p className="text-xs text-zinc-500 mt-2">
            Stored as basis points (integer math). Rate changes create a new
            effective rate card so historical earnings keep their original split.
          </p>
        </Section>
      )}

      <Section title="Branding" stepKey="branding">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-zinc-100 flex items-center justify-center">
            <Building2 className="w-5 h-5 text-zinc-400" />
          </div>
          {initialData.primaryColor && (
            <div className="flex items-center gap-1">
              <div
                className="w-5 h-5 rounded border border-zinc-200"
                style={{ backgroundColor: initialData.primaryColor }}
              />
              <span className="font-mono text-xs">
                {initialData.primaryColor}
              </span>
            </div>
          )}
          {initialData.secondaryColor && (
            <div className="flex items-center gap-1">
              <div
                className="w-5 h-5 rounded border border-zinc-200"
                style={{ backgroundColor: initialData.secondaryColor }}
              />
              <span className="font-mono text-xs">
                {initialData.secondaryColor}
              </span>
            </div>
          )}
          {!initialData.primaryColor &&
            !initialData.secondaryColor && <span>Skipped</span>}
        </div>
      </Section>

      <Section title="Team Invitations" stepKey="invite-team">
        {emails.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {emails.map((e) => (
              <Badge key={e} variant="outline" className="text-xs">
                {e}
              </Badge>
            ))}
            <p className="text-xs text-zinc-500 mt-1">
              Role: {MEMBER_ROLE_LABEL[inviteRole]}
            </p>
          </div>
        ) : (
          <span>No invitations — you can invite members later</span>
        )}
      </Section>

      {inviteResults && (
        <Card>
          <CardContent className="py-3 px-4 space-y-1">
            {inviteResults.map((r) => (
              <div
                key={r.email}
                className="flex items-center gap-2 text-sm"
              >
                {r.ok ? (
                  <Check className="h-4 w-4 text-emerald-500" />
                ) : (
                  <X className="h-4 w-4 text-red-500" />
                )}
                <span>{r.email}</span>
                {r.error && (
                  <span className="text-xs text-red-500">{r.error}</span>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex justify-between pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onBack}
          disabled={isSubmitting}
        >
          Back
        </Button>
        <Button
          type="button"
          onClick={handleLaunch}
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Launching…
            </>
          ) : (
            "Launch Organization"
          )}
        </Button>
      </div>
    </div>
  );
}
