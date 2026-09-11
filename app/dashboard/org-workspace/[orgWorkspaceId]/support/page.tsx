import { SupportSurface } from "@/components/dashboard/shared/support/SupportSurface";

/**
 * Support for enterprise operators.
 *
 * Until this page existed, the one person on the platform who signs the
 * contract and pays the invoices had no way to raise a ticket. An
 * `ORG_WORKSPACE` user holds neither a `ConsultantProfile` nor a
 * `ConsulteeProfile`, so they have no personal dashboard to fall back to the
 * way an org LEARNER does — and neither `org-workspace` nor
 * `organization/[orgId]` carried a support, feedback or help surface of its
 * own. The ticket queue in the back office simply never saw a B2B issue.
 *
 * `SupportSurface` is reused as-is rather than rebuilt: it is already
 * role-agnostic, and (#support-hub) now renders the Sessions/Platform hub.
 * Operator-only platform flows (org billing) activate server-side from
 * ACTIVE memberships, and escalated tickets carry `organizationId`
 * attribution — the "tickets carry no org" gap this page once documented is
 * closed.
 *
 * Still deliberately at the workspace layer rather than per-org — an operator
 * who manages several organizations needs one place to ask a question. The
 * per-org dashboard carries the org-scoped triage surfaces instead.
 */
export default async function OrgWorkspaceSupportPage({
  params,
}: {
  params: Promise<{ orgWorkspaceId: string }>;
}) {
  const { orgWorkspaceId } = await params;
  return <SupportSurface profileId={orgWorkspaceId} />;
}
