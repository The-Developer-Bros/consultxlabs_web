/**
 * Centralized OAuth provider configuration.
 *
 * All providers share one neutral outline button treatment (see
 * `SocialLoginButtons`). Per-provider full-bleed fills are deliberately NOT
 * configured here: black-on-black GitHub was near-invisible on the dark auth
 * pages, red/blue Google/Facebook fills outranked the primary email action,
 * and a red Google fill violates Google's Sign-In branding guidelines (white
 * #FFFFFF, dark #131314, or neutral #F2F2F2 only). Provider recognition comes
 * from the icon, not the fill.
 *
 * To add or remove a provider:
 * 1. Update `socialProviders` + `trustedProviders` in `lib/auth.ts`
 * 2. Add/remove entry here
 * 3. Add/remove icon in `components/auth/auth-icons.tsx` + PROVIDER_ICONS map
 * 4. Set the provider's env vars (CLIENT_ID + CLIENT_SECRET)
 */
export const AUTH_PROVIDERS = [
  {
    id: "github" as const,
    label: "GitHub",
  },
  {
    id: "google" as const,
    label: "Google",
  },
  {
    id: "facebook" as const,
    label: "Facebook",
  },
] as const;

export type AuthProviderId = (typeof AUTH_PROVIDERS)[number]["id"];
