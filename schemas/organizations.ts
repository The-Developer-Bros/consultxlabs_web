// schemas/organizations.ts
//
// Zod schemas for the `/api/organizations/**` route family — both
// outbound payloads (the dashboard sends to the server) and inbound
// responses (the server sends back). Mirrors what the route handlers
// declare with `z.object(...)` so a server-side change without a
// client-side update fails at parse time, not at render time.
//
// Convention: only put schemas here that are reused across two or more
// call sites. Anything truly one-off (e.g. a wizard step's local form
// shape) lives at the top of the consuming file under
// `components/organization/create-wizard/schemas.ts`.

import { z } from "zod";
import {
  HostInvitableMemberRoleSchema,
  MemberRoleSchema,
  SelfServiceFundingSourceSchema,
} from "@/lib/labels/org-labels";

// ───────────────────────────── Organization ─────────────────────────────

export const OrganizationSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  slug: z.string(),
  canSponsor: z.boolean().optional(),
  canHost: z.boolean().optional(),
});

export const CreateOrganizationResponseSchema = z.object({
  organization: OrganizationSummarySchema,
});

// Outbound payload for POST /api/organizations.
// Mirror the server's `CreateBodySchema` (app/api/organizations/route.ts)
// but only enforce the fields the wizard touches; the server keeps full
// authority on defaults (currency, dataResidencyRegion, requiresPO).
export const CreateOrganizationPayloadSchema = z.object({
  name: z.string().trim().min(2).max(200),
  billingEmail: z.string().email(),
  canSponsor: z.boolean(),
  canHost: z.boolean(),
  description: z.string().max(5000).optional(),
  industry: z.string().max(120).optional(),
  sizeBucket: z.string().optional(),
  website: z.string().url().optional(),
  // TODO(#714): PERSONAL on a sponsor org is reimbursement-only today —
  // member pays from their own card, the org gets a tag for reporting,
  // but there is no member-spend / reimbursement-report dashboard
  // surface yet. The wizard's BillingStep mounts a WIP banner when
  // PERSONAL is selected so operators see the gap.
  fundingSource: SelfServiceFundingSourceSchema.optional(),
  paymentTermsDays: z.number().int().min(0).max(180).optional(),
});

// PATCH /api/organizations/[orgId] — fields the dashboard surfaces.
// The wizard's Review step sends branding fields; the Settings page
// adds slug, capability flags, and the standard profile fields. Other
// PATCH fields (gstin, pan, gstStateCode, etc.) flow through their own
// dedicated forms and aren't validated here.
export const PatchOrganizationPayloadSchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9-]+$/, "Slug may only contain lowercase letters, digits, and hyphens")
    .optional(),
  description: z.string().max(5000).nullable().optional(),
  industry: z.string().max(120).nullable().optional(),
  website: z.string().url().nullable().optional(),
  billingEmail: z.string().email().optional(),
  paymentTermsDays: z.number().int().min(0).max(180).optional(),
  canSponsor: z.boolean().optional(),
  canHost: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Hex colour required")
    .nullable()
    .optional(),
  secondaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Hex colour required")
    .nullable()
    .optional(),
  // MSME declaration (#1230) — mirrors the server PATCH schema; feeds the
  // 15/45-day payout-deadline engine.
  msmeStatus: z.enum(["NONE", "MICRO", "SMALL", "MEDIUM"]).optional(),
  msmeWrittenAgreementOnFile: z.boolean().optional(),
});

// POST /api/organizations/[orgId]/rate-cards — 3-way split for host orgs.
// bps values must sum to 10 000 (enforced server-side; duplicated here so
// the wizard catches it before opening the network connection).
export const CreateRateCardPayloadSchema = z
  .object({
    platformBps: z.number().int().min(0).max(10000),
    orgBps: z.number().int().min(0).max(10000),
    consultantBps: z.number().int().min(0).max(10000),
  })
  .refine((v) => v.platformBps + v.orgBps + v.consultantBps === 10000, {
    message: "Revenue split must add up to 100%",
  });

// ───────────────────────────── Members ─────────────────────────────

const MemberStatusSchema = z.enum([
  "PENDING",
  "ACTIVE",
  "SUSPENDED",
  "REMOVED",
]);

export const MemberRowSchema = z.object({
  id: z.string(),
  // memberId is the BetterAuth bridge row id — server returns it for
  // legacy callers; the dashboard mostly uses `id` (Membership.id).
  memberId: z.string().optional(),
  role: MemberRoleSchema,
  status: MemberStatusSchema,
  // #729 — payout routing for EXPERT members (SELF / ORGANIZATION). Defaulted
  // for non-host rows; the edit dialog only surfaces the control for EXPERTs.
  payoutRecipient: z.enum(["SELF", "ORGANIZATION"]).default("SELF"),
  createdAt: z.string(),
  user: z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string(),
    image: z.string().nullable(),
  }),
});
export type MemberRow = z.infer<typeof MemberRowSchema>;

/** #902 — shared members page size. The SSR prefetch (lib/data/org-members) and
 *  the client's first query MUST use this same value (and matching queryKey) or
 *  hydration silently misses and the roster re-fetches on mount. Lives here (a
 *  client-safe module, no prisma) so both sides can import it. */
export const ORG_MEMBERS_PER_PAGE = 20;

export const MembersListResponseSchema = z.object({
  data: z.array(MemberRowSchema).default([]),
  meta: z
    .object({
      total: z.number().int().nonnegative(),
      page: z.number().int().positive(),
      perPage: z.number().int().positive(),
    })
    .optional(),
});

// POST /api/organizations/[orgId]/members
// Direct-add a member by email (dashboard path) OR userId (SSO /
// admin tooling). The server accepts either identifier, resolves
// email → userId internally, and returns 404 USER_NOT_FOUND when the
// account doesn't exist. The dashboard always sends email; userId is
// reserved for programmatic callers (SSO provisioning, admin scripts).
// EXPERT is in the wider HostInvitableMemberRoleSchema. It is only
// accepted by the server when the target org has canHost=true; the UI
// hides it for sponsor-only orgs (see MembersPageClient).
export const AddMemberPayloadSchema = z.object({
  email: z.string().email(),
  role: HostInvitableMemberRoleSchema,
});

// PATCH body shared with the edit-member dialog. At least one of role or
// status must be set; the server enforces a `.refine()` on the same
// constraint, so this mirror prevents an empty PATCH from ever leaving
// the client.
export const UpdateMemberPayloadSchema = z
  .object({
    role: MemberRoleSchema.optional(),
    status: MemberStatusSchema.optional(),
    // #729 — payout routing for an EXPERT (SELF → personal account,
    // ORGANIZATION → org absorbs + distributes). Server only honours it on
    // EXPERT members.
    payoutRecipient: z.enum(["SELF", "ORGANIZATION"]).optional(),
  })
  .refine(
    (v) =>
      v.role !== undefined ||
      v.status !== undefined ||
      v.payoutRecipient !== undefined,
    { message: "Provide at least one of role, status, or payout recipient" },
  );

// ───────────────────────────── Invitations ─────────────────────────────

// Invitation.status comes from BetterAuth's bridge table and is stored
// as a free-form lowercase string. We accept the canonical four states
// and gracefully tolerate anything else by relaxing the field — that
// avoids a parse-time crash if BetterAuth introduces a new state.
const InvitationStatusSchema = z
  .union([
    z.enum(["pending", "accepted", "rejected", "expired", "canceled", "revoked"]),
    z.string(),
  ])
  .transform((v) => v as string);

export const InvitationRowSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  // `role` is stored on the BetterAuth invite row as a string; we narrow
  // to MemberRole at the UI level for label lookup, but accept any string
  // so a future role addition doesn't crash the table.
  role: z.string(),
  status: InvitationStatusSchema,
  expiresAt: z.string(),
  createdAt: z.string(),
  inviterId: z.string().nullable(),
});
export type InvitationRow = z.infer<typeof InvitationRowSchema>;

export const InvitationsListResponseSchema = z.object({
  data: z.array(InvitationRowSchema).default([]),
});

// POST /api/organizations/[orgId]/invitations — outbound.
// Mirrors `InviteBodySchema` on the server. EXPERT is only accepted on
// canHost=true orgs; the server narrows back to the self-service subset
// for sponsor-only orgs and rejects with EXPERT_REQUIRES_CANHOST.
export const CreateInvitationPayloadSchema = z.object({
  email: z.string().email(),
  role: HostInvitableMemberRoleSchema,
  expiresInDays: z.number().int().min(1).max(30).optional(),
});

export const CreateInvitationResponseSchema = z.object({
  invitation: InvitationRowSchema,
});

// ───────────────────────────── SSO ─────────────────────────────

export const SsoProviderRowSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  issuer: z.string(),
  domain: z.string(),
  // Server occasionally hands back null when the provider was registered
  // before the type column existed; tolerate it so the table renders.
  providerType: z.enum(["saml", "oidc"]).nullable(),
});

export const SsoSettingsResponseSchema = z.object({
  settings: z.object({
    allowedEmailDomains: z.array(z.string()).default([]),
    enforceSSO: z.boolean(),
    // JIT auto-join is hard-locked to LEARNER (audit Phase A.1). The
    // server enforces this; the client schema mirrors it so a stale
    // response from a pre-fix server is caught at the parse boundary.
    defaultRoleForAutoJoin: z.literal("LEARNER"),
  }),
  providers: z.array(SsoProviderRowSchema).default([]),
});
export type SsoSettingsResponse = z.infer<typeof SsoSettingsResponseSchema>;

// PATCH /api/organizations/[orgId]/sso — outbound.
// Domain validation lives in `lib/enterprise/validators#DomainSchema`;
// we keep the array element loose here because the server is the
// authoritative validator and we already trim+filter at the UI level.
export const PatchSsoSettingsPayloadSchema = z.object({
  allowedEmailDomains: z.array(z.string()).optional(),
  enforceSSO: z.boolean().optional(),
  // Locked to LEARNER per audit Phase A.1 — client cannot pick the
  // role anymore; if some legacy caller still sends one, the server
  // rejects anything other than LEARNER with 400.
  defaultRoleForAutoJoin: z.literal("LEARNER").optional(),
});

// POST /api/organizations/[orgId]/sso/providers — outbound.
// Discriminated union on `providerType` so the SAML branch must include
// `samlConfig` and the OIDC branch must include `oidcConfig`. This catches
// a class of UI bugs at the call site (e.g. flipping the type radio
// without re-validating the matching config).
/**
 * #1132 — the IdP signing certificate must be a real X.509 PEM. `min(1)` let
 * any string through, and BetterAuth's SAML library then threw
 * `Cannot read properties of undefined (reading 'metadata')` deep inside
 * POST /api/auth/sign-in/sso — a 500 with an empty body and no way for the
 * admin to tell what was wrong. Validate the envelope and the base64 body here
 * so the error lands at configuration time with a message that names the field.
 */
const X509PemSchema = z
  .string()
  .min(1)
  .refine(
    (v) => {
      const m = v
        .trim()
        .match(
          /^-----BEGIN CERTIFICATE-----\r?\n([\s\S]+?)\r?\n-----END CERTIFICATE-----$/,
        );
      if (!m) return false;
      const body = m[1].replace(/\s+/g, "");
      // Base64 alphabet + correct padding, and long enough to be a real cert
      // rather than a placeholder.
      return /^[A-Za-z0-9+/]+={0,2}$/.test(body) && body.length >= 512;
    },
    {
      message:
        "Certificate must be a PEM-encoded X.509 certificate, including the BEGIN/END CERTIFICATE lines",
    },
  );

const SamlConfigSchema = z.object({
  issuer: z.string().min(1),
  entryPoint: z.string().url(),
  cert: X509PemSchema,
});
const OidcConfigSchema = z.object({
  issuer: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  discoveryEndpoint: z.string().url(),
  pkce: z.boolean(),
});
export const CreateSsoProviderPayloadSchema = z.discriminatedUnion(
  "providerType",
  [
    z.object({
      providerId: z.string().min(1),
      domain: z.string().min(1),
      issuer: z.string().min(1),
      providerType: z.literal("saml"),
      samlConfig: SamlConfigSchema,
    }),
    z.object({
      providerId: z.string().min(1),
      domain: z.string().min(1),
      issuer: z.string().min(1),
      providerType: z.literal("oidc"),
      oidcConfig: OidcConfigSchema,
    }),
  ],
);
export type CreateSsoProviderPayload = z.infer<
  typeof CreateSsoProviderPayloadSchema
>;
