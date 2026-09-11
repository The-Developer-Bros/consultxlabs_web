/**
 * @jest-environment node
 */

/**
 * #1134 — the grants script must not be appliable before the join route ships.
 *
 * `--apply` strips `join-call` from the `user` role. After that write the only
 * way into a call is to hold `call_member`, and the only thing that grants
 * `call_member` is `POST /api/meetings/[meetingId]/join`. Applying before that
 * route is live and serving traffic locks every user out of every call, for as
 * long as the window lasts.
 *
 * The script's existing post-apply guard does NOT catch this. It re-reads the
 * call type and checks whether Stream stored `join-call` on `call_member` —
 * which it will have. The grant is present; there is simply nobody holding the
 * role. So the guard passes and reports success for precisely the failure it
 * looks like it is there to prevent.
 *
 * It cannot be checked automatically either. Every route on the production
 * origin answers 404 to an unauthenticated request whether or not it is
 * deployed (verified against `familiarisenow.com`: `/api/meetings/x/join`,
 * `/api/meetings/x/nope`, and `/api/definitely-not-a-route` all return 404), so
 * there is no external probe that distinguishes the two states.
 *
 * Hence an assertion by the operator, behind a flag named after the thing being
 * asserted. These tests pin the three properties that make it worth having.
 */

import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(
  join(process.cwd(), "scripts/stream/ensure-call-type-grants.ts"),
  "utf8",
);

/** The gate's predicate, lifted from the source and pinned to it below. */
function gatePasses(opts: {
  apply: boolean;
  restore: boolean;
  deployConfirmed: boolean;
}): boolean {
  return !opts.apply || opts.restore || opts.deployConfirmed;
}

describe("the deploy-order gate", () => {
  it("refuses a bare --apply", () => {
    expect(
      gatePasses({ apply: true, restore: false, deployConfirmed: false }),
    ).toBe(false);
  });

  it("allows --apply once the deploy is asserted", () => {
    expect(
      gatePasses({ apply: true, restore: false, deployConfirmed: true }),
    ).toBe(true);
  });

  it("never blocks the emergency rollback", () => {
    // `--apply --restore-user-join` is what someone runs while every user is
    // locked out. Gating it behind a second flag they have to remember, at that
    // moment, would be the worst possible time to add a step.
    expect(
      gatePasses({ apply: true, restore: true, deployConfirmed: false }),
    ).toBe(true);
  });

  it("leaves the dry run alone", () => {
    // The dry run is read-only and is how anyone inspects the change. Requiring
    // a deploy assertion to look at a diff would train people to pass the flag
    // reflexively, which defeats it.
    expect(
      gatePasses({ apply: false, restore: false, deployConfirmed: false }),
    ).toBe(true);
  });
});

describe("the script actually implements this", () => {
  it("has the predicate, not just this test's copy", () => {
    expect(source).toContain(
      "if (!opts.apply || opts.restore || opts.deployConfirmed) return true;",
    );
  });

  it("runs the gate before touching Stream", () => {
    // A refusal must not depend on Stream being reachable, and must not read
    // the call type first — otherwise an outage turns a clear refusal into a
    // confusing connection error.
    const gateCall = source.indexOf("if (!requireDeployConfirmation(opts))");
    const configCheck = source.indexOf("if (!isStreamConfigured())");
    const firstRead = source.indexOf("client.video.getCallType");
    expect(gateCall).toBeGreaterThan(-1);
    expect(gateCall).toBeLessThan(configCheck);
    expect(gateCall).toBeLessThan(firstRead);
  });

  it("returns a failing exit code rather than continuing", () => {
    expect(source).toContain("if (!requireDeployConfirmation(opts)) return 1;");
  });

  it("names the rollback in the refusal message", () => {
    // Someone hitting this is about to do the dangerous thing. The recovery
    // command belongs in front of them, not in a doc they would have to find.
    const msg = source.slice(
      source.indexOf("🛑 Refusing to apply"),
      source.indexOf("return false;"),
    );
    expect(msg).toContain("--restore-user-join");
    expect(msg).toContain("--routes-are-deployed");
  });

  describe("the confirmation flag is named after everything it asserts", () => {
    /**
     * #1301 follow-up. The flag is what an operator types from memory; the
     * refusal message is what they read only after being refused.
     *
     * Naming it `--join-route-is-deployed` was a trap, and a live one:
     * verified on 2026-09-01 the join route IS on prod and the END route is
     * NOT, so an operator asserting something true about the join route would
     * have stripped `end-call` and taken End Call away from every host —
     * prod's `EndCallButton` still calls `call.endCall()` client-side.
     */
    it("accepts the plural flag", () => {
      expect(source).toContain('argv.includes("--routes-are-deployed")');
    });

    it("still accepts the old spelling, so a runbook keeps working", () => {
      // Being refused because you typed the previously-documented flag would
      // be its own small outage.
      expect(source).toContain('argv.includes("--join-route-is-deployed")');
    });

    it("documents the plural flag in the usage header and the refusal", () => {
      // Both places an operator copies from. Leaving either on the old name
      // would keep handing out the misleading one.
      const header = source.slice(0, source.indexOf("import "));
      expect(header).toContain("--routes-are-deployed");
      expect(header).not.toContain("--join-route-is-deployed");
    });
  });
});
