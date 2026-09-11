// Self-service-facing subsets of FundingSource and MemberRole are defined
// as Zod enums in lib/labels/org-labels.ts
// (SelfServiceFundingSource / SelfServiceMemberRole). The wizard reuses
// those directly rather than redeclaring them here — single source of
// truth for the subset.
import type {
  SelfServiceFundingSource,
  SelfServiceMemberRole,
} from "@/lib/labels/org-labels";

export interface OrgWizardData {
  // Step 0: Org Info
  name: string;
  // Capabilities replace the old kind enum. An org either sponsors
  // bookings, hosts consultants, or both (HYBRID is just both true).
  canSponsor: boolean;
  canHost: boolean;
  description: string;
  industry: string;
  sizeBucket: string;
  website: string;
  billingEmail: string;

  // Step 1: Billing (only when canSponsor = true)
  fundingSource?: SelfServiceFundingSource;
  paymentTermsDays: number; // meaningful when fundingSource = INVOICE

  // Step 1 alt: Revenue Rates (only when canHost = true). Stored as basis
  // points to avoid float drift; sum must equal 10000 at submit.
  platformBps: number;
  orgBps: number;
  consultantBps: number;

  // Step 2: Branding — colors only until the image-upload route lands.
  primaryColor: string | null;
  secondaryColor: string | null;

  // Step 3: Invite Team
  inviteEmails: string[];
  inviteRole: SelfServiceMemberRole;
}

export interface StepProps {
  onNext: (data: Partial<OrgWizardData>) => void;
  onBack: () => void;
  onGoToStep?: (step: number) => void;
  initialData: Partial<OrgWizardData>;
  isSubmitting?: boolean;
  /**
   * Whether a Back action is meaningful at the current step. True on all
   * steps beyond the first; true on the first step only when the caller
   * provided an `onCancel` to exit the wizard. The first-step component
   * (`OrgInfoStep`) reads this to decide whether to render its own Back
   * button.
   */
  canGoBack?: boolean;
  /** #863 — host orgs enabled (ENABLE_HOST_ORGS). OrgInfoStep hides the host
   *  capability when false. Server-read, threaded through the wizard. */
  hostOrgsEnabled?: boolean;
  /**
   * Optional hook for the Review step: runs after the final PATCH and
   * invitations succeed, before navigation. The onboarding caller uses
   * this to flip `user.onboardingCompleted = true` atomically with the
   * launch; dashboard (Nth-time) callers leave it undefined.
   */
  afterLaunch?: (orgId: string) => Promise<void> | void;
  /**
   * Optional override for the post-launch redirect target. Defaults to
   * `/dashboard/organization/{orgId}/home`.
   */
  finalRedirectPath?: (orgId: string) => string;
}

type StepKey =
  | "org-info"
  | "billing"
  | "revenue-rates"
  | "branding"
  | "invite-team"
  | "review";

export interface WizardStep {
  key: StepKey;
  label: string;
  subtitle: string;
}

/**
 * Returns the ordered list of wizard steps for a given capability shape.
 *
 * canSponsor-only: Org Info → Billing → Branding → Invite Team → Review    (5 steps)
 * canHost-only:    Org Info → Revenue Rates → Branding → Invite Team → Review (5 steps)
 * both (HYBRID):   Org Info → Billing → Revenue Rates → Branding → Invite Team → Review (6 steps)
 *
 * An org that has neither capability is a misconfiguration — the wizard
 * submit button validates at least one is set before advancing.
 */
export function getSteps(capabilities: {
  canSponsor: boolean;
  canHost: boolean;
}): WizardStep[] {
  const { canSponsor, canHost } = capabilities;

  return [
    {
      key: "org-info",
      label: "Org Info",
      subtitle: "Tell us about your organization. You can always update this later.",
    },
    ...(canSponsor
      ? [
          {
            key: "billing" as const,
            label: "Billing",
            subtitle: "Choose how your organization pays for its members' sessions.",
          },
        ]
      : []),
    ...(canHost
      ? [
          {
            key: "revenue-rates" as const,
            label: "Revenue Rates",
            subtitle:
              "Configure how earnings are split between the platform, your organization, and consultants.",
          },
        ]
      : []),
    {
      key: "branding",
      label: "Branding",
      subtitle: "Customize your organization's visual identity.",
    },
    {
      key: "invite-team",
      label: "Invite Team",
      subtitle: "Invite your team members by email.",
    },
    {
      key: "review",
      label: "Review",
      subtitle: "Review everything and launch your organization.",
    },
  ];
}
