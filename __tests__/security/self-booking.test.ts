/**
 * Nothing in checkout compared the booking user against the plan's owner.
 *
 * That matters because `ConsultantProfile` and `ConsulteeProfile` are
 * independent 1:1s off `User` and deliberately not mutually exclusive — the
 * roles doc says so outright, and ADR 18 keeps the B2B/B2C boundary open. So a
 * LEARNER in a sponsoring organization may also sell on the marketplace, and
 * could book their OWN plan against the org's credit pool: the sponsor's money
 * leaves the budget and arrives in their own payout account.
 *
 * The same-org EXPERT+LEARNER block in `lib/enterprise/role-transitions.ts`
 * does not reach this. It governs one Membership row; this needs only a
 * ConsulteeProfile and a plan. `ProgramConsultantAllowlist` would have caught
 * it, but under ADR 18's open network it is empty by default.
 *
 * The guard lives inside `revalidateInsideLock` — the same place ADR 18 chose
 * for allowlist enforcement — because that is where the plan's owner is
 * already loaded and the distributed lock closes the check-then-book race.
 * Asserting at the source level for the reason the refund-execution test
 * gives: standing up the whole checkout path would test the fixture, and what
 * matters is which check runs where.
 */

import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(
  join(process.cwd(), "lib/payments/operations/checkout.ts"),
  "utf8",
);

/** `revalidateInsideLock` body — everything the distributed lock protects. */
function insideLock(): string {
  const start = SRC.indexOf("async function revalidateInsideLock(");
  expect(start).toBeGreaterThan(-1);
  // Ends where the next top-level declaration begins.
  const end = SRC.indexOf("\nasync function ", start + 1);
  return SRC.slice(start, end > start ? end : undefined);
}

describe("a user cannot book their own plan", () => {
  it("compares the plan's owner against the booking user's consultant profile", () => {
    const body = insideLock();

    expect(body).toContain(
      "plan.consultantProfileId === user.consultantProfile.id",
    );
    expect(body).toContain("You cannot book your own plan.");
  });

  it("loads the consultant profile it compares against", () => {
    const body = insideLock();

    // Without this the comparison silently reads undefined and the guard
    // never fires — the failure mode would be a check that looks present
    // and does nothing.
    expect(body).toContain("consultantProfile: { select: { id: true } }");
  });

  it("runs under the lock, before the ADR-18 panel and exclusivity checks", () => {
    const body = insideLock();

    const guard = body.indexOf("You cannot book your own plan.");
    const panel = body.indexOf("programConsultantAllowlist");
    const exclusivity = body.indexOf("exclusiveEngagement");

    expect(guard).toBeGreaterThan(-1);
    expect(panel).toBeGreaterThan(-1);
    expect(exclusivity).toBeGreaterThan(-1);

    // Cheapest and most fundamental check first: an allowlist lookup is a
    // query, and self-dealing is refused whether or not a panel is
    // configured.
    expect(guard).toBeLessThan(panel);
    expect(guard).toBeLessThan(exclusivity);
  });

  it("guards every paid path, not only org-sponsored ones", () => {
    const body = insideLock();
    const open = body.indexOf("if (\n      plan.consultantProfileId &&");
    // Anchor first: without this the slice below is empty on unfixed code and
    // the two `not.toContain`s pass vacuously.
    expect(open).toBeGreaterThan(-1);

    const guardBlock = body.slice(
      open,
      body.indexOf("You cannot book your own plan."),
    );
    expect(guardBlock.length).toBeGreaterThan(0);

    // The ADR-18 panel check is `if (programId)`-scoped because a curated
    // panel only exists for org funding. Self-dealing has no such carve-out,
    // so the guard must not be nested under a funding condition.
    expect(guardBlock).not.toContain("programId");
    expect(guardBlock).not.toContain("organizationId");
  });

  it("still allows the ordinary case — a plan owned by someone else", () => {
    const body = insideLock();

    // Both sides must be present before it throws, so a consultee with no
    // consultant profile (the overwhelming majority) is never caught by it.
    const guard = body.slice(
      body.indexOf("if (\n      plan.consultantProfileId &&"),
      body.indexOf("You cannot book your own plan."),
    );
    expect(guard).toContain("plan.consultantProfileId &&");
    expect(guard).toContain("user.consultantProfile &&");
  });
});
