/**
 * Wave-9 (#1230) — org-context pricing hint for the offering editor.
 *
 * When the signed-in teacher holds an ACTIVE membership in an org that can
 * sponsor programs (canSponsor), a brand-new offering is very likely meant
 * to be bookable at ₹0 under that org's LICENSED_SEAT / CREDIT_POOL program
 * — members' checkout settles against the program instead of their card.
 *
 * This is deliberately a HINT, not enforcement: the default price is already
 * ₹0, so all we add is an honest caption on the price field explaining what
 * ₹0 means in org context. The teacher can still charge whatever they want.
 *
 * Pure functions only — no React, no Prisma, so it unit-tests anywhere.
 */

import type { OfferingManifest } from "./manifest";

/** The slice of `session.user.organizationMemberships[]` this helper reads. */
export interface SponsorMembershipLike {
  status?: string;
  canSponsor?: boolean;
  organizationName?: string;
}

/**
 * Returns the caption text when the caller qualifies, null otherwise.
 * First qualifying membership wins; the server already trims memberships to
 * ACTIVE, but filtering here keeps the helper honest if that ever drifts.
 */
export function resolveSponsorPricingHint(
  memberships: SponsorMembershipLike[] | undefined | null,
): string | null {
  const sponsor = (memberships ?? []).find(
    (m) => m.canSponsor && (!m.status || m.status === "ACTIVE"),
  );
  if (!sponsor) return null;
  return sponsor.organizationName
    ? `Included for ${sponsor.organizationName} members — org-sponsored bookings settle against the program at checkout, not the member's card.`
    : "Included for your organisation's members — org-sponsored bookings settle against the program at checkout, not the member's card.";
}

/**
 * Immutably stamps the hint onto the manifest's primary price field
 * (`kind: "price"`, path "price"). Only called for NEW offerings — editing
 * keeps whatever description the manifest declares.
 */
export function applySponsorPricingHintToManifest(
  manifest: OfferingManifest,
  hint: string,
): OfferingManifest {
  return {
    ...manifest,
    sections: manifest.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) =>
        field.kind === "price" && field.name === "price"
          ? { ...field, description: hint }
          : field,
      ),
    })),
  };
}
