import type {
  FundingSource,
  MemberRole,
  MemberStatus,
  OrgStatus,
} from "@prisma/client";

/**
 * Single source of truth for the (post-transform) shape returned by
 * `GET /api/organizations/[orgId]` on the client. Previously the org
 * layout and `useOrgRole` each declared their own interface AND each
 * transformed the raw API payload (flattening `billingAccount.fundingSource`
 * onto `organization`). When the two interfaces drifted, background
 * react-query refetches could land a sparse shape in the shared
 * `["organization", orgId]` cache and crash the layout's reads of
 * `org.organization.name / .logo / .status`.
 *
 * Consumers that need only a subset pick fields off this type rather
 * than redeclaring a narrower interface. Adding a new field to the API
 * happens here; both the layout and the role hook pick it up on next
 * compile.
 */
export interface OrgDetailsResponse {
  organization: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    status: OrgStatus;
    canSponsor: boolean;
    canHost: boolean;
    /**
     * Flattened from the server's nested `billingAccount.fundingSource`.
     * `null` when the org has no BillingAccount (pure HOST-only orgs, or
     * pre-billing-setup state).
     */
    fundingSource: FundingSource | null;
    /**
     * India AP 3-way-match toggle. When true the org's finance team
     * pre-issues Purchase Order numbers from their own AP system and we
     * require every Contract / Invoice to reference a live PO. The org
     * dashboard's Purchase Orders tab is hidden when this is false —
     * showing it to orgs that don't run POs is just nav noise.
     */
    requiresPO: boolean;
  };
  /**
   * The caller's membership in this org. Always present in a 200
   * response: `GET /api/organizations/[orgId]` runs through
   * `requireOrgAccess`, which either returns a real Membership, a
   * synthesized ADMIN stub, or a 403. A null membership would mean
   * the caller bypassed the access check — not representable here.
   */
  membership: {
    role: MemberRole;
    status: MemberStatus;
    /**
     * Set when this member also delivers sessions. Distinct from
     * `role === "EXPERT"` — an OWNER or MANAGER can hold a consultant profile
     * too, and the delivery surfaces (Requests) key off the profile, not the
     * role.
     */
    consultantProfileId: string | null;
  };
}

/**
 * Raw shape the server sends over the wire, before the client-side
 * flatten step. Kept internal to the two fetchers that consume it —
 * callers of `OrgDetailsResponse` should never see this.
 */
export interface RawOrgDetailsResponse {
  organization: Omit<
    OrgDetailsResponse["organization"],
    "fundingSource" | "logo"
  > & {
    billingAccount?: { fundingSource: FundingSource } | null;
    brandingProfile?: { logo: string | null } | null;
  };
  membership: OrgDetailsResponse["membership"];
}

/**
 * Flatten the server's nested `billingAccount.fundingSource` onto the
 * `organization` object. Pure function — exported so both the org
 * layout's `fetchOrg` (throws on error) and `useOrgRole`'s
 * `fetchOrgDetails` (fails closed) can share the transform without
 * sharing their error strategy.
 */
export function flattenOrgDetails(
  raw: RawOrgDetailsResponse,
): OrgDetailsResponse {
  return {
    organization: {
      id: raw.organization.id,
      name: raw.organization.name,
      slug: raw.organization.slug,
      // Branding lives on the OrgBrandingProfile satellite (#768 lockdown #6) —
      // Organization itself has no logo column. Same flatten every other reader
      // does.
      logo: raw.organization.brandingProfile?.logo ?? null,
      status: raw.organization.status,
      canSponsor: raw.organization.canSponsor,
      canHost: raw.organization.canHost,
      fundingSource: raw.organization.billingAccount?.fundingSource ?? null,
      requiresPO: raw.organization.requiresPO,
    },
    membership: raw.membership,
  };
}
