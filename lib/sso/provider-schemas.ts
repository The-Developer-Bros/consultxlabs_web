/**
 * Zod schemas for SSO provider registration.
 *
 * `callbackUrl` is deliberately absent from `samlConfigSchema`: BetterAuth
 * auto-derives the ACS URL as `{baseURL}/api/auth/sso/saml2/sp/acs/{providerId}`,
 * and accepting a user-typed override silently breaks SAML when the value
 * drifts from BetterAuth's derived URL. The read-only URL shown in the Add
 * Provider dialog is always in sync because both it and BetterAuth derive
 * from the same `providerId`.
 *
 * Extracted from the API route so the shape can be unit-tested and so any
 * future edits to `samlConfigSchema` must touch this single file — which
 * the invariants check in `scripts/verify-sso-invariants.sh` greps for the
 * forbidden `callbackUrl` key.
 */

import { X509Certificate } from "node:crypto";
import { z } from "zod";

export const oidcConfigSchema = z.object({
  issuer: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  discoveryEndpoint: z.string().url(),
  pkce: z.boolean().default(true),
  scopes: z.array(z.string()).optional(),
});

/**
 * Validate a SAML signing certificate as a parseable PEM-encoded X.509.
 *
 * Why we validate here, not later:
 *   BetterAuth's underlying SAML adapter (`@node-saml/node-saml`) parses
 *   the cert lazily inside `validatePostResponse` when an assertion
 *   arrives. If the cert is garbage, the call chain crashes with
 *     TypeError: Cannot read properties of undefined (reading 'metadata')
 *   and returns a 500 with an empty body to the user clicking the SSO
 *   button. The UI has no way to recover — there's no error message
 *   to surface. By validating at the schema layer (registration time),
 *   we fail closed with a friendly PEM-format error that the admin
 *   actually sees in the Add Provider dialog.
 *
 * What Node's X509Certificate accepts:
 *   - PEM-encoded with `-----BEGIN CERTIFICATE-----` / `-----END CERTIFICATE-----`
 *     markers and base64 body.
 *   - DER-encoded (binary) — passed as a Buffer.
 *   - Throws `ERR_OSSL_*` or `ERR_INVALID_ARG_TYPE` on anything else.
 *   Wrapping in try/catch normalizes both error families to a boolean.
 *
 * See audit Phase A.2 + `docs/enterprise/20-iam-and-security/01-sso-and-authentication.md#cert-rotation`.
 */
/**
 * Exported because the same parse-or-fail check needs to run at two
 * additional sites beyond schema registration:
 *
 *   1. The pre-auth `/api/auth/sso/domain-check` endpoint, to short-circuit
 *      with `SSO_PROVIDER_MISCONFIGURED` BEFORE the user is bounced to
 *      BetterAuth's SAML flow (which would crash the request and return
 *      an empty-body 500 — see audit Phase A.2).
 *
 *   2. The daily `sso-cert-expiry-alert` cron, to detect legacy provider
 *      rows whose certs were registered before this validator existed.
 */
export function validateSamlCert(value: string): boolean {
  try {
    // The constructor parses the cert; we don't need the instance.
    new X509Certificate(value);
    return true;
  } catch {
    return false;
  }
}

export const samlConfigSchema = z.object({
  issuer: z.string().min(1),
  entryPoint: z.string().url(),
  cert: z.string().refine(validateSamlCert, {
    message:
      "Invalid X.509 certificate. Paste the PEM block from your IdP — it should start with -----BEGIN CERTIFICATE----- and end with -----END CERTIFICATE-----. If you copied a base64 fingerprint by mistake, your IdP's admin console has a separate 'Certificate (PEM)' download.",
  }),
});

export const createProviderSchema = z.object({
  providerId: z
    .string()
    .trim()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/i, "providerId must be alphanumeric"),
  domain: z.string().trim().min(3).max(255),
  issuer: z.string().trim().min(1).max(500),
  providerType: z.enum(["saml", "oidc"]),
  samlConfig: samlConfigSchema.optional(),
  oidcConfig: oidcConfigSchema.optional(),
});
