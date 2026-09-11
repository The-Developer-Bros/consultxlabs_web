/**
 * Guards against regressions in the IdP-setup URLs surfaced in the Add
 * Provider dialog. If BetterAuth's default endpoint templates ever drift
 * from these, the URLs we hand to IT admins would no longer match the ACS
 * BetterAuth actually mounts, and SAML assertions / OIDC callbacks would
 * be rejected silently.
 *
 * See also: scripts/verify-sso-invariants.sh (grep-level check).
 */

import { deriveAcsUrl, deriveMetadataUrl } from "@/lib/sso/derive-urls";

const BASE = "http://localhost:3000";

describe("deriveAcsUrl", () => {
  test("SAML uses the /saml2/sp/acs/{providerId} endpoint", () => {
    expect(deriveAcsUrl("acme-okta", "saml", BASE)).toBe(
      "http://localhost:3000/api/auth/sso/saml2/sp/acs/acme-okta",
    );
  });

  test("OIDC uses the /callback/{providerId} endpoint", () => {
    expect(deriveAcsUrl("acme-auth0", "oidc", BASE)).toBe(
      "http://localhost:3000/api/auth/sso/callback/acme-auth0",
    );
  });

  test("null type falls back to the SAML template (add-dialog preview case)", () => {
    expect(deriveAcsUrl("acme", null, BASE)).toBe(
      "http://localhost:3000/api/auth/sso/saml2/sp/acs/acme",
    );
  });

  test("empty providerId substitutes a placeholder (empty form state)", () => {
    expect(deriveAcsUrl("", "saml", BASE)).toBe(
      "http://localhost:3000/api/auth/sso/saml2/sp/acs/<provider-id>",
    );
  });

  test("baseUrl is injected verbatim (no trailing-slash normalisation)", () => {
    expect(deriveAcsUrl("x", "oidc", "https://app.prod.example.com")).toBe(
      "https://app.prod.example.com/api/auth/sso/callback/x",
    );
  });
});

describe("deriveMetadataUrl", () => {
  test("always the SAML metadata endpoint with providerId as query param", () => {
    expect(deriveMetadataUrl("acme-okta", BASE)).toBe(
      "http://localhost:3000/api/auth/sso/saml2/sp/metadata?providerId=acme-okta",
    );
  });

  test("empty providerId substitutes a placeholder", () => {
    expect(deriveMetadataUrl("", BASE)).toBe(
      "http://localhost:3000/api/auth/sso/saml2/sp/metadata?providerId=<provider-id>",
    );
  });
});
