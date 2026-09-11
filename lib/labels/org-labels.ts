/**
 * Shared user-facing labels for Organization + Membership + BillingAccount.
 *
 * Every dashboard badge, form option, review summary, and checkout subtitle
 * that needs a human-readable version of an Arch-4 capability/funding enum
 * pulls from here. Centralising avoids the taxonomy drift we saw before
 * Arch-4, when labels were defined inline in OrgContextBar vs
 * OrganizationSwitcher vs org-list and disagreed with each other.
 *
 * Palette conventions:
 *   - Sponsor (buyer-side): blue
 *   - Host (seller-side):   emerald
 *   - Hybrid (both):        purple
 *   - Personal (no org):    zinc
 *
 * Funding-source palette mirrors the financial weight of the mode:
 *   - Personal: zinc   (learner pays own card)
 *   - Wallet:   amber  (pre-funded credit pool)
 *   - Invoice:  orange (postpaid; expects settlement action)
 *   - License:  green  (fully paid, no per-session billing)
 */

import type {
  FundingSource,
  MemberRole,
  MemberStatus,
  OrgDirectoryType,
  OrgSizeBucket,
} from "@prisma/client";

// ───────────────────────────── Capability ─────────────────────────────

export type CapabilityKind = "SPONSOR" | "HOST" | "HYBRID" | "INERT";

export function deriveCapabilityKind(
  canSponsor: boolean,
  canHost: boolean,
): CapabilityKind {
  if (canSponsor && canHost) return "HYBRID";
  if (canSponsor) return "SPONSOR";
  if (canHost) return "HOST";
  return "INERT";
}

export const CAPABILITY_LABEL: Record<CapabilityKind, string> = {
  SPONSOR: "Sponsor",
  HOST: "Host",
  HYBRID: "Hybrid",
  INERT: "Inactive",
};

export const CAPABILITY_BADGE_CLASS: Record<CapabilityKind, string> = {
  SPONSOR: "bg-blue-100 text-blue-900 border-blue-200",
  HOST: "bg-emerald-100 text-emerald-900 border-emerald-200",
  HYBRID: "bg-purple-100 text-purple-900 border-purple-200",
  INERT: "bg-zinc-100 text-zinc-600 border-zinc-200",
};

export const CAPABILITY_DESCRIPTION: Record<CapabilityKind, string> = {
  SPONSOR:
    "Pays for its members' sessions. Has a BillingAccount; does not host consultants.",
  HOST:
    "Hosts consultants who earn through the organization. Has a payout account; does not sponsor anyone.",
  HYBRID:
    "Both sponsors its members and hosts consultants. Runs both money flows independently.",
  INERT:
    "Neither sponsors nor hosts. Typically a transitional state — usually means the org was created but never configured.",
};

// ───────────────────────────── FundingSource ─────────────────────────────

export const FUNDING_SOURCE_LABEL: Record<FundingSource, string> = {
  PERSONAL: "Personal",
  WALLET: "Wallet",
  INVOICE: "Invoice",
  LICENSE: "License",
};

export const FUNDING_SOURCE_TAGLINE: Record<FundingSource, string> = {
  PERSONAL:
    "Members pay at checkout with their own card; the org is tagged for reporting only.",
  WALLET:
    "Org pre-purchases a credit pool. Credits are deducted automatically when members book.",
  INVOICE:
    "Members book freely. One consolidated invoice at month-end; pay within NET terms.",
  LICENSE:
    "Flat-fee enterprise license. Sessions are unmetered for the contract period.",
};

export const FUNDING_SOURCE_BADGE_CLASS: Record<FundingSource, string> = {
  PERSONAL: "bg-zinc-100 text-zinc-700 border-zinc-200",
  WALLET: "bg-amber-100 text-amber-900 border-amber-200",
  INVOICE: "bg-orange-100 text-orange-900 border-orange-200",
  LICENSE: "bg-green-100 text-green-900 border-green-200",
};

// ───────────────────────────── MemberRole ─────────────────────────────

// UI labels mirror the enum values 1:1 — one vocabulary across code,
// logs, and user-facing copy. Avoids the "enum says MAINTAINER, UI says
// Admin" mismatch that makes support tickets confusing.
export const MEMBER_ROLE_LABEL: Record<MemberRole, string> = {
  OWNER: "Owner",
  MAINTAINER: "Maintainer",
  BILLING_ADMIN: "Billing admin",
  MANAGER: "Manager",
  EXPERT: "Expert",
  LEARNER: "Learner",
  SUPPORT: "Support",
};

// Zod enum mirroring the prisma MemberRole enum; exported for callers that
// need to narrow a string coming from the API / DB at a boundary where
// typescript can't prove the type.
export const MemberRoleSchema = z.enum([
  "OWNER",
  "MAINTAINER",
  "BILLING_ADMIN",
  "MANAGER",
  "EXPERT",
  "LEARNER",
  "SUPPORT",
]);

export const MEMBER_ROLE_DESCRIPTION: Record<MemberRole, string> = {
  OWNER: "Full control: billing, members, settings, deletion.",
  MAINTAINER:
    "Members, plans, programs, and settings. No billing or deletion.",
  // Why a separate finance role: large orgs delegate AP / GL to a
  // specialized team that needs invoice + payout + rate-card + wallet
  // mutation rights without the ability to touch SSO, member roster,
  // or org status. Sitting at rank 70 (between MAINTAINER 80 and
  // MANAGER 60) means the gate matrix flows naturally — SSO routes
  // gated at MAINTAINER+ auto-deny, billing routes gated at
  // BILLING_ADMIN-or-OWNER explicitly allow.
  BILLING_ADMIN:
    "Manages invoices, POs, payouts, rate cards, and outbound webhooks. No member or SSO changes.",
  MANAGER: "Team analytics, seat management, earnings view.",
  EXPERT: "Delivers services on behalf of the organization.",
  LEARNER: "Consumes services through the organization's programs.",
  SUPPORT: "Views support tickets and assists members. No billing.",
};

// ───────────────────────────── MemberStatus ─────────────────────────────

export const MEMBER_STATUS_LABEL: Record<MemberStatus, string> = {
  PENDING: "Pending",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  REMOVED: "Removed",
  // DPDP §12 right-to-erasure tombstone. Surfaced as "Erased" in
  // member lists so operators understand the row will never reactivate.
  ERASED: "Erased",
};

export const MEMBER_STATUS_BADGE_CLASS: Record<MemberStatus, string> = {
  PENDING: "bg-amber-100 text-amber-900 border-amber-200",
  ACTIVE: "bg-green-100 text-green-900 border-green-200",
  SUSPENDED: "bg-orange-100 text-orange-900 border-orange-200",
  REMOVED: "bg-zinc-100 text-zinc-600 border-zinc-200",
  // Deliberately darker than REMOVED — visually communicates
  // "permanent, regulatory" rather than "operator action, reversible".
  ERASED: "bg-zinc-200 text-zinc-700 border-zinc-300 italic",
};

// ───────────────────────────── Zod narrowing schemas ─────────────────────────────
//
// Rather than ad-hoc `typeof v === "string" && arr.includes(v)` checks
// sprinkled through every form, we keep the authoritative subset here as
// Zod enums. Callers import the schema and use `.safeParse` to narrow at
// runtime; the derived TypeScript types come from `z.infer`. One module
// owns the option list + the type + the validator — adding a new value
// updates all three.
//
// Why subsets?
//   - Prisma's full `MemberRole` enum includes CONSULTANT and SUPPORT.
//     Self-service wizards shouldn't let a founder pick those (CONSULTANT
//     needs canHost=true and the apply flow; SUPPORT is an operator role).
//   - Prisma's full `FundingSource` enum includes PROJECT, which is v2
//     (milestone workflow missing). Keeping it out of self-service keeps
//     invalid states unrepresentable.

import { z } from "zod";

export const SelfServiceFundingSourceSchema = z.enum([
  "PERSONAL",
  "WALLET",
  "INVOICE",
  "LICENSE",
]);
export type SelfServiceFundingSource = z.infer<
  typeof SelfServiceFundingSourceSchema
>;
export const SELF_SERVICE_FUNDING_SOURCES =
  SelfServiceFundingSourceSchema.options;

// Self-service onboarding for a sponsor-only org exposes the four
// non-privileged MemberRoles. EXPERT is assigned only on canHost=true
// orgs (see HostInvitableMemberRoleSchema below); SUPPORT is an
// operator role assigned by owners from Settings.
// BILLING_ADMIN is included here so OWNERs can invite a finance lead
// from the org-creation wizard onwards without leaving the dashboard.
// SUPPORT remains operator-only (assigned by OWNERs from Settings).
export const SelfServiceMemberRoleSchema = z.enum([
  "OWNER",
  "MAINTAINER",
  "BILLING_ADMIN",
  "MANAGER",
  "LEARNER",
]);
export type SelfServiceMemberRole = z.infer<typeof SelfServiceMemberRoleSchema>;
export const SELF_SERVICE_MEMBER_ROLES = SelfServiceMemberRoleSchema.options;

/**
 * Role-floor for JIT (Just-In-Time) SSO auto-provisioning.
 *
 * When a user signs in via the org's IdP for the first time and no
 * Membership row exists yet, `lib/auth.ts:customSession` creates one
 * with `OrganizationSSOSettings.defaultRoleForAutoJoin`. Restricting
 * that field to `LEARNER` enforces principle-of-least-privilege:
 *
 *   - An attacker who somehow gets past the IdP (misconfigured Okta,
 *     IdP-issued unverified email, etc.) lands as LEARNER, not OWNER.
 *   - Org admins explicitly promote new members from `/dashboard/
 *     organization/<id>/members` after first signin — a deliberate
 *     audit-logged action.
 *
 * Previously, `SelfServiceMemberRoleSchema` was reused here, which
 * allowed `defaultRoleForAutoJoin = "OWNER"`. With SSO enabled, the
 * first SSO user became co-owner instantly. That's a catastrophic
 * privilege-grant; see audit Phase A.1.
 *
 * See `docs/enterprise/20-iam-and-security/01-sso-and-authentication.md#jit-default-role`.
 */
export const JitDefaultRoleSchema = z.literal("LEARNER");

// Host-invitable subset — adds EXPERT to the self-service set. Used by
// the Members + Invitations dashboard surfaces and the matching server
// schemas when the org has canHost=true. EXPERT carries the implicit
// guarantee that the org has a payout account, so the canHost gate is
// non-negotiable: a sponsor-only org assigning EXPERT would have no
// settlement path for the consultant's earnings.
export const HostInvitableMemberRoleSchema = z.enum([
  "OWNER",
  "MAINTAINER",
  "BILLING_ADMIN",
  "MANAGER",
  "LEARNER",
  "EXPERT",
]);
export const HOST_INVITABLE_MEMBER_ROLES =
  HostInvitableMemberRoleSchema.options;

/**
 * Returns the role list a self-service inviter can pick on the given
 * org, gated by capability:
 *   - operator roles (OWNER / MAINTAINER / BILLING_ADMIN / MANAGER) always render
 *   - LEARNER only when canSponsor=true (sponsor-side; needs Contract/Program/Wallet
 *     to actually fund sessions — host-only orgs have no settlement path)
 *   - EXPERT only when canHost=true (host-side; needs payout account / RateCard)
 *
 * Single source of truth for both the dropdown population (UI) and the
 * server-side capability gates (`LEARNER_REQUIRES_CANSPONSOR` +
 * `EXPERT_REQUIRES_CANHOST` in the members + invitations routes).
 */
export function getInvitableRoles(
  canSponsor: boolean,
  canHost: boolean,
): MemberRole[] {
  const roles: MemberRole[] = [
    "OWNER",
    "MAINTAINER",
    "BILLING_ADMIN",
    "MANAGER",
  ];
  if (canSponsor) roles.push("LEARNER");
  if (canHost) roles.push("EXPERT");
  return roles;
}

/**
 * Narrow an untyped value to a self-service funding source, falling back
 * to PERSONAL if the input is unrecognized. Use at form-hydration +
 * Select `onValueChange` boundaries instead of `as`.
 */
export function narrowFundingSource(
  v: unknown,
  fallback: SelfServiceFundingSource = "PERSONAL",
): SelfServiceFundingSource {
  const parsed = SelfServiceFundingSourceSchema.safeParse(v);
  return parsed.success ? parsed.data : fallback;
}

/**
 * Narrow an untyped value to a self-service member role, falling back to
 * LEARNER if unrecognized.
 */
export function narrowSelfServiceRole(
  v: unknown,
  fallback: SelfServiceMemberRole = "LEARNER",
): SelfServiceMemberRole {
  const parsed = SelfServiceMemberRoleSchema.safeParse(v);
  return parsed.success ? parsed.data : fallback;
}

// ───────────────────────── Public directory taxonomy ─────────────────────────

/**
 * What kind of organisation a visitor is looking at, for the public directory.
 * Distinct from CapabilityKind above: "Hybrid" is billing vocabulary that means
 * nothing to a marketplace visitor, whereas these are the categories the
 * marketing copy has always promised.
 *
 * No badge-class map — directory type is a neutral taxonomy, so it renders
 * monochrome (filled vs muted) like every other non-status categorical here.
 */
export const ORG_DIRECTORY_TYPE_LABEL: Record<OrgDirectoryType, string> = {
  EXPERT_NETWORK: "Expert network",
  CONSULTING_AGENCY: "Consulting agency",
  LEARNING_INSTITUTION: "Learning institution",
  CORPORATE_ACADEMY: "Corporate academy",
  OTHER: "Organisation",
};

export const ORG_DIRECTORY_TYPE_DESCRIPTION: Record<OrgDirectoryType, string> =
  {
    EXPERT_NETWORK:
      "Curates a panel of independent experts you can book directly.",
    CONSULTING_AGENCY:
      "A consulting firm offering its consultants through the platform.",
    LEARNING_INSTITUTION:
      "A university, school, or research institute running programs.",
    CORPORATE_ACADEMY:
      "A company's internal learning arm, open to external learners.",
    OTHER: "An organisation on Familiarise.",
  };

/**
 * Visitor-facing phrasing for the capability pair, for the public directory.
 * Distinct from CAPABILITY_LABEL above, which is the dashboard's internal
 * vocabulary ("Host" / "Hybrid") and means nothing to a marketplace visitor.
 * `inert` renders nothing rather than the internal "Inactive".
 */
export const ORG_PUBLIC_CAPABILITY_LABEL: Record<
  "host" | "sponsor" | "hybrid" | "inert",
  string
> = {
  host: "Hosts experts",
  sponsor: "Sponsors members",
  hybrid: "Hosts & sponsors",
  inert: "",
};

export const ORG_SIZE_BUCKET_LABEL: Record<OrgSizeBucket, string> = {
  SMALL_1_50: "1–50 people",
  MEDIUM_51_200: "51–200 people",
  LARGE_201_1000: "201–1,000 people",
  ENTERPRISE_1000_PLUS: "1,000+ people",
};
