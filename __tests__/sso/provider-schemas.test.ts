/**
 * Guards against regressions in the SSO provider POST schema.
 *
 * The most important invariant: `samlConfig` must NOT accept a `callbackUrl`.
 * BetterAuth auto-derives the ACS URL; letting admins type a custom value is
 * a footgun that silently breaks SAML when it drifts from BetterAuth's
 * derived endpoint. See issue #672 Gap 6 for history.
 */

import {
  createProviderSchema,
  samlConfigSchema,
  oidcConfigSchema,
} from "@/lib/sso/provider-schemas";

/**
 * Why we inline a real X.509 PEM instead of a placeholder
 * --------------------------------------------------------
 * `samlConfigSchema` runs the cert string through Node's `X509Certificate`
 * constructor (lib/sso/provider-schemas.ts → `validateSamlCert`) to fail
 * closed on garbage at registration time. A `"MIIC..."` placeholder is
 * not parseable base64 and the constructor throws
 * `ERR_OSSL_ASN1_BAD_OBJECT_HEADER`, so the test must hand the schema a
 * cert that actually parses.
 *
 * This fixture is a self-signed RSA-2048 cert generated once with
 *   openssl req -x509 -newkey rsa:2048 -nodes -days 36500 -subj /CN=...
 * It is **parse-only** — never used to verify a SAML signature — so its
 * expiry, key strength, and identity are intentionally irrelevant.
 * Re-generate without ceremony if it ever needs replacing.
 */
const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDIzCCAgugAwIBAgIUdIXLLS2I0pg1nRxPsX7Sk2wL7GAwDQYJKoZIhvcNAQEL
BQAwIDEeMBwGA1UEAwwVZmFtaWxpYXJpc2UtdGVzdC1jZXJ0MCAXDTI2MDUxNjA1
MzM0M1oYDzIxMjYwNDIyMDUzMzQzWjAgMR4wHAYDVQQDDBVmYW1pbGlhcmlzZS10
ZXN0LWNlcnQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCNzbqR3o7y
ffbVj9X4Ea1TiFnGpXFfu599YDhFmproj05DqnjgAfJH5IfKL4yVE5fnFBy5Sa83
mc1FZUl9BGtfQGt/5FUK5vQ6wI+yQhCUVT4iN0hldgjiw/VY7XjSdGImBpDOJk+8
g1qVcfuOB3kRbEBo46smx+ESGjnwEDEYCa11VN0COPYJXrHSDIRwn5IHjskOVdoF
dZ+mu9pM/9MSckXZ+lCEVgC4RvHqZrXkWoY4tTluk4I8G9LkSEbOGo3Q3a+GEKCZ
cXgoUKSLMfCKMt5CTbCvqAvSiDudJja0ACVoDYL6Vf+PnOewBChP0ReZvZinRS1u
ovEi17At4hr7AgMBAAGjUzBRMB0GA1UdDgQWBBQArnYD6KV36Si8Srb+TJ8dwsYy
BjAfBgNVHSMEGDAWgBQArnYD6KV36Si8Srb+TJ8dwsYyBjAPBgNVHRMBAf8EBTAD
AQH/MA0GCSqGSIb3DQEBCwUAA4IBAQB7yQ8/P1OcC57xNqJsqtpCr/PHcvIsuvAX
+UEcTpJDXgG6M4O7IhF8CGtnFgKhbucAuTj/lWPS8kwCtjnG5wIibgComRlAyiNU
AFGl1+wLkHWMQRwjeQ0LD/Lafd4Mqr3/uLXAdjtri3cco3ZLpq8+b4QxrhZ2sb0t
0CfV+qZful0jbRd/VnaMws2jW7lUA0wYhirka+sFFqWII1P6SjvxGzPs68Ro7JE5
iuxSGXsz1dHPrWW2FgOlOq8tBcBhGaRHsdd2oBFB6RcCVmKyVth4x/I9OWIuyMXY
zI7Ra8q1TUULKRu7kbkXo8Apyv3nkX+E36UONay6CF7fL3IIjZh5
-----END CERTIFICATE-----`;

describe("samlConfigSchema", () => {
  const valid = {
    issuer: "https://idp.acme.com",
    entryPoint: "https://idp.acme.com/sso/saml",
    cert: TEST_CERT_PEM,
  };

  test("accepts minimal valid SAML config", () => {
    expect(samlConfigSchema.safeParse(valid).success).toBe(true);
  });

  test("strips unknown keys including the forbidden callbackUrl", () => {
    const withCallback = {
      ...valid,
      callbackUrl: "https://attacker.example.com/evil",
    };
    const result = samlConfigSchema.safeParse(withCallback);
    // The schema is permissive of unknown keys but must NOT expose them
    // downstream. If `callbackUrl` ever becomes part of the typed output,
    // BetterAuth will honour it and override the derived ACS URL.
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("callbackUrl");
    }
  });

  test("rejects a non-URL entryPoint", () => {
    const result = samlConfigSchema.safeParse({ ...valid, entryPoint: "not-a-url" });
    expect(result.success).toBe(false);
  });

  test("rejects an empty cert", () => {
    const result = samlConfigSchema.safeParse({ ...valid, cert: "" });
    expect(result.success).toBe(false);
  });

  test("rejects malformed base64 inside PEM markers", () => {
    // BEGIN/END framing only — the body is not valid base64-encoded DER, so
    // X509Certificate throws ERR_OSSL_ASN1_BAD_OBJECT_HEADER. The refine
    // catches this and surfaces the friendly PEM-shape error from the schema.
    const result = samlConfigSchema.safeParse({
      ...valid,
      cert: "-----BEGIN CERTIFICATE-----\nMIIC...not-valid-base64\n-----END CERTIFICATE-----",
    });
    expect(result.success).toBe(false);
  });

  test("rejects a plain string with no PEM markers", () => {
    // A bare fingerprint (hex) or thumb-printed value pasted by mistake
    // never has BEGIN/END markers; X509Certificate refuses it outright.
    const result = samlConfigSchema.safeParse({
      ...valid,
      cert: "ab12cd34ef56789012345678901234567890abcd",
    });
    expect(result.success).toBe(false);
  });
});

describe("oidcConfigSchema", () => {
  const valid = {
    issuer: "https://tenant.auth0.com/",
    clientId: "abc123",
    clientSecret: "shh",
    discoveryEndpoint: "https://tenant.auth0.com/.well-known/openid-configuration",
    pkce: true,
  };

  test("accepts a full OIDC config", () => {
    expect(oidcConfigSchema.safeParse(valid).success).toBe(true);
  });

  test("pkce defaults to true when omitted — required to prevent the raw-fetch regression", () => {
    const { pkce, ...rest } = valid;
    void pkce;
    const result = oidcConfigSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pkce).toBe(true);
    }
  });
});

describe("createProviderSchema", () => {
  test("rejects non-alphanumeric providerId (prevents path-injection in auto-derived URLs)", () => {
    const result = createProviderSchema.safeParse({
      providerId: "../admin",
      domain: "acme.com",
      issuer: "https://idp.acme.com",
      providerType: "saml",
      samlConfig: {
        issuer: "https://idp.acme.com",
        entryPoint: "https://idp.acme.com/sso",
        cert: "cert",
      },
    });
    expect(result.success).toBe(false);
  });

  test("providerType must be saml or oidc", () => {
    const result = createProviderSchema.safeParse({
      providerId: "x",
      domain: "acme.com",
      issuer: "https://idp.acme.com",
      providerType: "ldap",
    });
    expect(result.success).toBe(false);
  });
});
