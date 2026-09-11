/**
 * User-facing copy for organization-lifecycle API error codes.
 *
 * Some org routes return a machine-readable code in the `error` field
 * (e.g. `ORG_NOT_VERIFIED` from `requireOrgAccess` when an org is still
 * PENDING_VERIFICATION). The dashboard surfaces these codes in toasts,
 * dialogs, and inline form errors, so we need one place that maps code
 * → sentence.
 *
 * This sits next to `org-labels.ts` rather than under `lib/errors/`
 * because it mirrors the label-table pattern (`MEMBER_ROLE_LABEL`,
 * `FUNDING_SOURCE_LABEL`) — one record per enum-like vocabulary. The
 * `lib/errors/` tree is reserved for the payment classification +
 * toast-dispatch machinery, which is keyed on `errorType` (a different
 * axis) and lives on the billing/booking path.
 *
 * Adding a new code: append to `ORG_ERROR_COPY`, then emit it from the
 * server handler. Unknown codes fall through `humanizeOrgError` to the
 * raw message so genuine free-form errors still render.
 */

export const ORG_ERROR_COPY: Record<string, string> = {
  ORG_NOT_VERIFIED:
    "Your organization is awaiting platform review. This action will be available once a Familiarise admin verifies your account — this usually takes 1–2 business days.",
  ROLE_TRANSITION_BLOCKED:
    "Members cannot switch between Learner and Expert roles. Remove the member and re-invite them with the new role instead.",
  USER_NOT_FOUND:
    "No user account found with that email. They need to sign up at Familiarise first, or use the Invitations page to send them an invite.",
  EXPERT_REQUIRES_CANHOST:
    "Expert can only be assigned on host-capable organizations. Enable hosting under Settings → Capabilities first.",
  // Why: #729 strict acceptance criterion #5. Adding a user as Expert
  // is a roster-membership action, not an identity-grant — the target
  // must already have opted into being a consultant on Familiarise.
  // Previously the route lazy-created a ConsultantProfile for any
  // user added as Expert, which silently promoted strangers to
  // consultants. The dashboard now refuses with this message.
  NOT_A_CONSULTANT:
    "This user is not a consultant on Familiarise yet. They need to sign up as an Expert first before they can be added to an organization as one.",
  // Symmetric to NOT_A_CONSULTANT — the org dashboard refuses to
  // lazy-create a ConsulteeProfile for a stranger being added as
  // Learner. The target must already have a consumer-side identity on
  // Familiarise (most users do by default, but consultant-only or SSO-
  // provisioned accounts may not).
  NOT_A_CONSULTEE:
    "This user does not have a learner profile on Familiarise yet. They need to sign up or complete onboarding before they can be added to an organization as a Learner.",
  LEARNER_REQUIRES_CANSPONSOR:
    "Learner can only be assigned on sponsor-capable organizations. Enable sponsorship under Settings → Capabilities first.",
// Why: PO balance enforcement (see docs/enterprise/10-money-and-ledger/08-invoicing.md
  // "PO balance enforcement" section). The server emits EXCEEDED; the
  // INSUFFICIENT alias exists so route renames don't break the UI copy.
  PO_BALANCE_EXCEEDED:
    "This purchase order doesn't have enough remaining budget for the invoice. Reduce the invoice total or add a new PO.",
  PO_BALANCE_INSUFFICIENT:
    "This purchase order doesn't have enough remaining budget for the invoice. Reduce the invoice total or add a new PO.",
  // Why: domain-claim gates on SSO provider registration. Operators
  // pasting the wrong corporate domain saw a 422 with no actionable
  // copy; these strings point them at the exact recovery flow.
  DOMAIN_NOT_OWNED:
    "Your organization hasn't claimed this email domain yet. Add it under Settings → SSO → Domains and verify before registering a provider.",
  DOMAIN_NOT_VERIFIED:
    "The domain claim is pending DNS verification. Finish the TXT-record step under Settings → SSO → Domains.",
  // Why: pre-auth runtime guard at /api/auth/sso/domain-check — see
  // docs/enterprise/20-iam-and-security/01-sso-and-authentication.md "Pre-auth runtime
  // guard". Surfaced when a stored SAML cert is unparseable; we want
  // operators (not end users) to know to re-paste the PEM.
  SSO_PROVIDER_MISCONFIGURED:
    "Your SSO provider's certificate is invalid. Contact your IT admin to re-paste the X.509 PEM.",
  // Why: hard-gate replacing the WIP banner on `canHost`. The friendly
  // copy points operators at the recovery path (talk to ops) rather
  // than leaving them stranded with a generic 400.
  HOST_ORGS_GATED:
    "Host-capable organizations are not yet enabled on this tenant. Contact ops at support@familiarise.work to flip ENABLE_HOST_ORGS for your account.",
};

/**
 * Translate a server-provided error string into user-facing copy.
 * If the string matches a known code, returns the mapped sentence.
 * Otherwise returns the input unchanged, so free-form server messages
 * (e.g. validation feedback) still reach the user verbatim.
 */
export function humanizeOrgError(message: string): string {
  return ORG_ERROR_COPY[message] ?? message;
}
