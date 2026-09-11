import { CreateOrganizationWizard } from "@/components/organization/create-wizard/Wizard";
import { ENABLE_HOST_ORGS } from "@/lib/feature-flags";

/**
 * Nth-time org creation for an already-authenticated ORG_WORKSPACE operator. The
 * first-time flow runs inline at /form/onboarding when the user picks the
 * Organization Owner role tile; that caller passes `afterLaunch` to flip
 * `user.onboardingCompleted = true`. This page just wraps the shared
 * wizard with the dashboard's cancel path.
 *
 * Server component so it can read ENABLE_HOST_ORGS (#863) and hide the host
 * capability when off — the wizard + steps are client components below.
 */
export default function CreateOrganizationPage() {
  return (
    <CreateOrganizationWizard
      cancelHref="/dashboard/organization"
      hostOrgsEnabled={ENABLE_HOST_ORGS}
    />
  );
}
