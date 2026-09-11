/**
 * @jest-environment node
 */

/**
 * Coverage guarantee for `humanizeOrgError` — every typed error code
 * emitted from `app/api/organizations/**` must have a corresponding
 * friendly sentence here. The dashboard renders these via toasts and
 * inline form errors, so an un-mapped code surfaces a raw machine
 * string ("ROLE_TRANSITION_BLOCKED") instead of the intended copy.
 *
 * The unknown-code fall-through is also pinned — free-form server
 * messages (Zod validation, ad-hoc 4xx bodies) must continue to reach
 * the user verbatim. See UI.M.4 in enterprise-test-findings.txt.
 */

import { humanizeOrgError, ORG_ERROR_COPY } from "@/lib/labels/org-errors";

describe("humanizeOrgError", () => {
  const KNOWN_CODES: Array<[code: string, mustContain: RegExp]> = [
    // (code, a substring or regex the friendly copy MUST contain)
    ["ORG_NOT_VERIFIED", /awaiting platform review/i],
    ["ROLE_TRANSITION_BLOCKED", /Learner and Expert roles/i],
    ["USER_NOT_FOUND", /sign up at Familiarise/i],
    ["EXPERT_REQUIRES_CANHOST", /host-capable organizations/i],
    ["PO_BALANCE_EXCEEDED", /remaining budget/i],
    ["PO_BALANCE_INSUFFICIENT", /remaining budget/i],
    ["DOMAIN_NOT_OWNED", /Add it under Settings → SSO → Domains/i],
    ["DOMAIN_NOT_VERIFIED", /TXT-record/i],
    ["SSO_PROVIDER_MISCONFIGURED", /X\.509 PEM/i],
  ];

  test.each(KNOWN_CODES)(
    "maps %s to friendly copy that mentions the recovery hint",
    (code, mustContain) => {
      const out = humanizeOrgError(code);
      expect(out).not.toBe(code);
      expect(out).toMatch(mustContain);
    },
  );

  it("returns unknown codes verbatim (free-form server messages)", () => {
    expect(humanizeOrgError("Something blew up at line 42")).toBe(
      "Something blew up at line 42",
    );
    // Lookalike strings that aren't in the table must also pass through
    // unchanged — never coerced into one of the known sentences.
    expect(humanizeOrgError("PO_BALANCE_UNKNOWN")).toBe("PO_BALANCE_UNKNOWN");
  });

  it("the alias PO_BALANCE_INSUFFICIENT renders the same copy as PO_BALANCE_EXCEEDED", () => {
    // The server only emits EXCEEDED today, but the INSUFFICIENT alias is
    // pinned so a future route rename doesn't silently change UI copy.
    expect(humanizeOrgError("PO_BALANCE_INSUFFICIENT")).toBe(
      humanizeOrgError("PO_BALANCE_EXCEEDED"),
    );
  });

  it("snapshot of the full mapping table", () => {
    // Why: forces every PR that adds/removes a code to either explain
    // itself in a snapshot diff or update this single guard. Pairs with
    // the human-readable per-code assertions above.
    expect(ORG_ERROR_COPY).toMatchSnapshot();
  });
});
