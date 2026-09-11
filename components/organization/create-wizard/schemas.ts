import { z } from "zod";

export const orgInfoSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(100),
  billingEmail: z.string().email("Must be a valid email"),
  description: z.string().max(2000),
  industry: z.string(),
  sizeBucket: z.string(),
  website: z.string(),
  // Capability booleans replace the old `kind` enum. Submit validates
  // that at least one is true — an org that neither sponsors nor hosts
  // has no purpose to exist.
  canSponsor: z.boolean(),
  canHost: z.boolean(),
});

export const billingSchema = z.object({
  // PERSONAL / WALLET / INVOICE / LICENSE — PROJECT is admin-only and
  // not exposed in the self-service wizard (milestone workflow missing).
  fundingSource: z.enum(["PERSONAL", "WALLET", "INVOICE", "LICENSE"]),
  // paymentTermsDays is only meaningful when fundingSource = INVOICE.
  // We accept it in all cases so the form can retain the value if the
  // user flips back and forth across funding sources.
  paymentTermsDays: z.coerce.number().int().min(1).max(120),
});

export const brandingSchema = z.object({
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color")
    .nullable()
    .optional(),
  secondaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color")
    .nullable()
    .optional(),
});

// Basis points (integers summing to 10000) replace float percentages.
// Integer math keeps rounding deterministic across high-volume settlements
// and removes the need to chase drift between `SUM(splits) - grossAmount`.
export const revenueRatesSchema = z
  .object({
    platformBps: z.coerce.number().int().min(0).max(10000),
    orgBps: z.coerce.number().int().min(0).max(10000),
    consultantBps: z.coerce.number().int().min(0).max(10000),
  })
  .refine(
    (d) => d.platformBps + d.orgBps + d.consultantBps === 10000,
    { message: "Basis points must sum to exactly 10000 (100%)" },
  );

export type OrgInfoFormData = z.infer<typeof orgInfoSchema>;
export type BillingFormData = z.infer<typeof billingSchema>;
export type BrandingFormData = z.infer<typeof brandingSchema>;
export type RevenueRatesFormData = z.infer<typeof revenueRatesSchema>;
