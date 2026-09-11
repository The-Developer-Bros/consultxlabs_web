/**
 * BetterAuth auto-mounts these routes from the `sso()` plugin. Keep this
 * derivation in sync with the plugin's default endpoint templates — changing
 * the paths here without a matching override in `lib/auth.ts` will break the
 * IdP-setup instructions shown to org workspace operators in the Add Provider dialog.
 *
 * These helpers are pure so they can be unit-tested without a DOM / React
 * runtime. See `__tests__/sso/derive-urls.test.ts`.
 */

export type SsoProviderType = "saml" | "oidc" | null;

export function deriveAcsUrl(
  providerId: string,
  type: SsoProviderType,
  baseUrl: string = process.env.NEXT_PUBLIC_APP_URL ?? "",
): string {
  const slug = providerId || "<provider-id>";
  return type === "oidc"
    ? `${baseUrl}/api/auth/sso/callback/${slug}`
    : `${baseUrl}/api/auth/sso/saml2/sp/acs/${slug}`;
}

export function deriveMetadataUrl(
  providerId: string,
  baseUrl: string = process.env.NEXT_PUBLIC_APP_URL ?? "",
): string {
  const slug = providerId || "<provider-id>";
  return `${baseUrl}/api/auth/sso/saml2/sp/metadata?providerId=${slug}`;
}
