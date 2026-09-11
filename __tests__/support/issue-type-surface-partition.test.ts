/**
 * @jest-environment node
 */

/**
 * Every `SupportIssueType` belongs to exactly one surface.
 *
 * Two independent lists decide where a user can raise an issue:
 *
 *   - `SESSION_SCOPED_ISSUE_TYPES` (lib/support/create-ticket.ts) — the server
 *     side. The platform ticket route 422s these, telling the user to open the
 *     appointment's "Get help" instead.
 *   - `PLATFORM_ISSUE_TYPE_CATEGORIES` (utils/supportTicketUrl.ts) — the client
 *     side, a hand-grouped constant that decides what the platform form offers.
 *
 * Nothing links them. They happened to be exact complements, which is how
 * `TECHNICAL_ISSUES` came to sit on the platform dropdown while a since-deleted
 * constant in the same file classified it as a Session Issue — a user whose
 * CALL broke filed a company-wide ticket with no session attached.
 *
 * The lists stay hand-written (grouping and order are editorial). This is the
 * guard: add an enum member and it must land in exactly one of them.
 */

import { SupportIssueType } from "@prisma/client";
import { SESSION_SCOPED_ISSUE_TYPES } from "@/lib/support/create-ticket";
import {
  ISSUE_TYPE_LABELS,
  PLATFORM_ISSUE_TYPE_CATEGORIES,
} from "@/utils/supportTicketUrl";

// Widened deliberately: the constant is `as const`, so its element type is the
// narrow union of what it happens to list today — which would make
// `includes(<any enum member>)` a type error rather than the runtime check
// this file exists to perform.
const platformTypes: SupportIssueType[] = Object.values(
  PLATFORM_ISSUE_TYPE_CATEGORIES,
).flat();
const allTypes: SupportIssueType[] = Object.values(SupportIssueType);

describe("issue-type surface partition", () => {
  it("offers no session-scoped type on the platform form", () => {
    // The failure this prevents: the form offers something the API refuses,
    // so the user picks it and hits a 422 they cannot act on.
    const leaked = platformTypes.filter((t) => SESSION_SCOPED_ISSUE_TYPES.has(t));
    expect(leaked).toEqual([]);
  });

  it("classifies every issue type to exactly one surface", () => {
    // A member in neither list is unreachable: refused by the platform form's
    // absence and never offered anywhere else.
    const orphans = allTypes.filter(
      (t) => !SESSION_SCOPED_ISSUE_TYPES.has(t) && !platformTypes.includes(t),
    );
    expect(orphans).toEqual([]);

    const both = allTypes.filter(
      (t) => SESSION_SCOPED_ISSUE_TYPES.has(t) && platformTypes.includes(t),
    );
    expect(both).toEqual([]);
  });

  it("covers the whole enum between the two lists", () => {
    expect(SESSION_SCOPED_ISSUE_TYPES.size + platformTypes.length).toBe(
      allTypes.length,
    );
  });

  it("keeps the platform list free of duplicates across its groups", () => {
    expect(new Set(platformTypes).size).toBe(platformTypes.length);
  });

  it("labels TECHNICAL_ISSUES as platform-scoped, not session-scoped", () => {
    // Regression pin for the specific leak: a bare "Technical issues" label is
    // what a user whose call dropped reaches for on the platform form.
    expect(ISSUE_TYPE_LABELS[SupportIssueType.TECHNICAL_ISSUES]).toMatch(
      /site|app/i,
    );
    // In-session audio/video trouble is the session-scoped type instead.
    expect(SESSION_SCOPED_ISSUE_TYPES.has(SupportIssueType.COMMUNICATION_ISSUE)).toBe(
      true,
    );
  });
});
