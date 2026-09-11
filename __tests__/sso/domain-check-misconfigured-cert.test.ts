/**
 * @jest-environment node
 */

/**
 * Pre-auth guard: `/api/auth/sso/domain-check` must refuse to hand the
 * client an `ssoBody` (which the signin page would feed into
 * BetterAuth's SAML flow) when the stored provider cert is unparseable.
 *
 * Without this guard, BetterAuth's SAML adapter crashes inside
 * `validatePostResponse` and the user sees an empty-body 500 with no
 * actionable error. The route should instead return
 * `{ enforceSSO: true, providerMisconfigured: true,
 *    errorCode: "SSO_PROVIDER_MISCONFIGURED" }` so the signin page can
 * surface a friendly toast.
 *
 * Closes bug SSO.1 from enterprise-test-findings.txt.
 */

import { NextRequest } from "next/server";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    ssoProvider: { findFirst: jest.fn() },
    organization: { findUnique: jest.fn() },
  },
}));

jest.mock("../../lib/sso/enforce-session", () => ({
  lookupEnforcedOrg: jest.fn(),
}));

import prisma from "@/lib/prisma";
import { lookupEnforcedOrg } from "@/lib/sso/enforce-session";
import { GET } from "@/app/api/auth/sso/domain-check/route";

const mockedPrisma = prisma as unknown as {
  ssoProvider: { findFirst: jest.Mock };
  organization: { findUnique: jest.Mock };
};
const mockedLookup = lookupEnforcedOrg as jest.Mock;

function makeRequest(email: string) {
  return new NextRequest(
    `http://localhost/api/auth/sso/domain-check?email=${encodeURIComponent(email)}`,
  );
}

describe("GET /api/auth/sso/domain-check — provider cert pre-flight", () => {
  beforeEach(() => {
    mockedLookup.mockReset();
    mockedPrisma.ssoProvider.findFirst.mockReset();
    mockedPrisma.organization.findUnique.mockReset();
    // Common happy-path enforcement scaffolding.
    mockedLookup.mockResolvedValue({
      organizationId: "org-1",
      registeredProviderIds: ["acme-saml"],
    });
    mockedPrisma.organization.findUnique.mockResolvedValue({ name: "Acme" });
  });

  it("returns providerMisconfigured when stored SAML cert is unparseable", async () => {
    mockedPrisma.ssoProvider.findFirst.mockResolvedValue({
      providerId: "acme-saml",
      // Placeholder body — passes the BEGIN/END marker shape but not the
      // X509 parse, exactly the case that crashes BetterAuth's adapter.
      samlConfig: JSON.stringify({
        issuer: "https://idp.acme.com",
        entryPoint: "https://idp.acme.com/saml",
        cert:
          "-----BEGIN CERTIFICATE-----\nMIIC...not-valid-base64\n-----END CERTIFICATE-----",
      }),
      oidcConfig: null,
    });

    const res = await GET(makeRequest("user@acme.com"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      enforceSSO: true,
      providerMisconfigured: true,
      errorCode: "SSO_PROVIDER_MISCONFIGURED",
    });
    expect(body).not.toHaveProperty("ssoBody");
  });

  it("returns providerMisconfigured when samlConfig is not parseable JSON", async () => {
    mockedPrisma.ssoProvider.findFirst.mockResolvedValue({
      providerId: "acme-saml",
      samlConfig: "{this-is-not-json",
      oidcConfig: null,
    });

    const res = await GET(makeRequest("user@acme.com"));
    const body = await res.json();
    expect(body).toEqual({
      enforceSSO: true,
      providerMisconfigured: true,
      errorCode: "SSO_PROVIDER_MISCONFIGURED",
    });
  });

  it("still hands out ssoBody for an OIDC provider with no SAML cert", async () => {
    // OIDC providers don't have a cert; they hit different failure
    // modes (discoveryEndpoint unreachable, clientSecret rejected) that
    // are out of scope for this guard. The route must NOT classify them
    // as misconfigured purely on the basis of `samlConfig` being null.
    mockedPrisma.ssoProvider.findFirst.mockResolvedValue({
      providerId: "acme-oidc",
      samlConfig: null,
      oidcConfig: JSON.stringify({
        issuer: "https://acme.auth0.com/",
        clientId: "abc",
        clientSecret: "shh",
        discoveryEndpoint:
          "https://acme.auth0.com/.well-known/openid-configuration",
        pkce: true,
      }),
    });

    const res = await GET(makeRequest("user@acme.com"));
    const body = await res.json();
    expect(body.enforceSSO).toBe(true);
    expect(body.providerMisconfigured).toBeUndefined();
    expect(body.ssoBody).toEqual({
      providerId: "acme-oidc",
      domain: "acme.com",
      callbackURL: expect.stringContaining("/auth/signin"),
    });
  });
});
