import { Prisma } from "@prisma/client";
import { z } from "zod";

/**
 * Public projection for ConsultantProfile — the safe, non-PII scalar allowlist used
 * to `select` a consultant row anywhere it crosses a trust boundary (a public
 * response, or another principal's payload). Mirrors the vetted field set in
 * `getConsultantDetail`.
 *
 * PRIMARY control: the statutory-PII scalars (PAN, bank/SWIFT, TDS, residency,
 * MSME, ...) are deliberately absent, so a query built on this NEVER fetches them
 * from Postgres — default-deny at the source, so PII never enters app memory, logs,
 * or Sentry breadcrumbs. Spread it into a `select` and add the relations a surface
 * needs:
 *   `consultantProfile: { select: { ...consultantPublicScalars, user: {...}, ... } }`
 * (#946)
 */
export const consultantPublicScalars = {
  id: true,
  userId: true,
  domainId: true,
  description: true,
  experience: true,
  rating: true,
  headline: true,
  websiteUrl: true,
  twitterUrl: true,
  githubUrl: true,
  videoIntroUrl: true,
  languages: true,
  toolsAndTechnologies: true,
  mentoringStyle: true,
  sessionTypes: true,
  profileCompletionPercentage: true,
  isVerified: true,
  verificationStatus: true,
  totalMenteesHelped: true,
  scheduleType: true,
  isIndependent: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ConsultantProfileSelect;

/**
 * The `select` shape of the public scalar allowlist — for typing consumer payloads
 * whose `consultantProfile` is now projected down, e.g.
 * `GetPayload<{ include: { consultantProfile: { select: ConsultantPublicScalars & { user: {...} } } } }>`.
 * Type-only re-export so consumer type files needn't pull the runtime value (or zod).
 */
export type ConsultantPublicScalars = typeof consultantPublicScalars;

/**
 * The statutory-PII scalars that `consultantPublicScalars` omits — an explicit
 * denylist for documentation and for the Zod output tripwire below. Any new
 * sensitive ConsultantProfile field MUST be added here AND kept out of
 * `consultantPublicScalars`.
 */
export const CONSULTANT_PII_FIELDS = [
  "panNumber",
  "ibanOrAccount",
  "swiftBic",
  "bankCurrency",
  "residencyStatus",
  "taxEntityType",
  "providerCountry",
  "tdsRateBps",
  "tdsSection",
  "tdsLowerRateCert",
  "tdsLowerRateCertRateBps",
  "tdsLowerRateCertValidFrom",
  "tdsLowerRateCertValidTo",
  "rbiPurposeCode",
  "udyamNumber",
  "msmeStatus",
  "writtenAgreementWithFamiliarise",
] as const;

/**
 * Sensitive ConsultantProfile RELATIONS (financial / compliance) that must never be
 * selected into a public payload. `consultantPublicScalars` already excludes them
 * (it is scalars-only), so this is the defense-in-depth list the Zod tripwire also
 * checks: if a future query accidentally selects one, the parse fails closed. (#946)
 */
export const CONSULTANT_SENSITIVE_RELATIONS = [
  "earnings",
  "payouts",
  "payoutAccounts",
  "taxInfo",
  "tdsRecords",
  "tdsAdjustments",
  "verificationRequests",
] as const;

/**
 * Zod OUTPUT contract for the flat public consultant API responses — defense-in-depth
 * over the `select` allowlist. It declares the safe consultant scalars, `.passthrough()`s
 * the relations (so nothing legitimate is dropped), and hard-fails via `.superRefine`
 * if ANY PII key is present. Net effect: `consultantPublicApiSchema.parse(row)` returns
 * the row unchanged when clean, but FAILS CLOSED (throws → the route 500s) rather than
 * ever leaking, if a future query drifts and re-introduces a PII column.
 */
export const consultantPublicApiSchema = z
  .object({
    id: z.string(),
    userId: z.string().nullish(),
    domainId: z.string().nullish(),
    description: z.string().nullish(),
    experience: z.number().nullish(),
    rating: z.number().nullish(),
    headline: z.string().nullish(),
    websiteUrl: z.string().nullish(),
    twitterUrl: z.string().nullish(),
    githubUrl: z.string().nullish(),
    videoIntroUrl: z.string().nullish(),
    languages: z.array(z.string()).optional(),
    toolsAndTechnologies: z.array(z.string()).optional(),
    mentoringStyle: z.string().nullish(),
    sessionTypes: z.array(z.string()).optional(),
    profileCompletionPercentage: z.number().nullish(),
    isVerified: z.boolean().nullish(),
    verificationStatus: z.string().nullish(),
    totalMenteesHelped: z.number().nullish(),
    scheduleType: z.string().nullish(),
    isIndependent: z.boolean().nullish(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
  })
  .passthrough()
  .superRefine((val, ctx) => {
    for (const f of [
      ...CONSULTANT_PII_FIELDS,
      ...CONSULTANT_SENSITIVE_RELATIONS,
    ]) {
      if (f in val) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Sensitive field/relation "${f}" must not appear in a public consultant payload`,
        });
      }
    }
  });

export type ConsultantPublic = z.infer<typeof consultantPublicApiSchema>;
