/**
 * `getDmChannelId` mints three shapes; `stream-channel-ids.ts` used to know one.
 *
 * `"dmo-".startsWith("dm-")` is false, and so is `"dmh-".startsWith("dm-")`.
 * Because `DM_PREFIX` was the only DM prefix declared:
 *
 *   - `getChannelTypeFromId("dmo-…")` fell through to its `team` default and
 *     returned `"team"` for a channel that was created as `messaging`. Four
 *     call sites then addressed the wrong type: the member-add action, both
 *     maintenance drain passes, and the event-channel expiry job.
 *   - `isDMChannel` answered false for two of the three DM forms.
 *   - `MANAGED_CHANNEL_PREFIXES` omitted them, so the reconciler never saw
 *     org-context DMs at all.
 *
 * None of that throws. A wrong channel type is a 404 or a duplicate channel,
 * both silent — which is why this is pinned rather than left to review.
 */
import {
  DM_HASHED_PREFIX,
  DM_ORG_PREFIX,
  DM_PREFIX,
  MANAGED_CHANNEL_PREFIXES,
  getChannelTypeFromId,
  isDMChannel,
  isEventChannel,
} from "@/lib/stream-channel-ids";
import { getDmChannelId } from "@/lib/stream-utils";

// Two cuids, as Better Auth / Prisma produce them.
const CUID_A = "cmqb1680e0014txyocn1f0dbz";
const CUID_B = "cmqb1680e0015txyocn1f0abc";
// 36-char uuids — the 17 legacy accounts that overflow the 64-char ceiling.
const UUID_A = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const UUID_B = "9c858901-8a57-4791-81fe-4c455b099bc9";
const ORG_ID = "org_acme_0001";

describe("every DM id form is a recognised messaging channel", () => {
  const cases: Array<[string, string]> = [
    ["personal", getDmChannelId(CUID_A, CUID_B)],
    ["org-scoped", getDmChannelId(CUID_A, CUID_B, ORG_ID)],
    ["hashed overflow", getDmChannelId(UUID_A, UUID_B)],
  ];

  it.each(cases)("%s ids start with a declared prefix", (_label, id) => {
    expect(
      [DM_PREFIX, DM_ORG_PREFIX, DM_HASHED_PREFIX].some((p) =>
        id.startsWith(p),
      ),
    ).toBe(true);
  });

  it.each(cases)("%s resolves to the messaging type", (_label, id) => {
    expect(getChannelTypeFromId(id)).toBe("messaging");
  });

  it.each(cases)("%s is recognised as a DM", (_label, id) => {
    expect(isDMChannel(id)).toBe(true);
  });

  it.each(cases)("%s is not mistaken for an event channel", (_label, id) => {
    expect(isEventChannel(id)).toBe(false);
  });

  it.each(cases)("%s is reconciled, not orphaned", (_label, id) => {
    expect(
      MANAGED_CHANNEL_PREFIXES.some((prefix) => id.startsWith(prefix)),
    ).toBe(true);
  });
});

describe("the three forms stay distinct", () => {
  it("org and personal ids for the same pair differ", () => {
    expect(getDmChannelId(CUID_A, CUID_B)).not.toBe(
      getDmChannelId(CUID_A, CUID_B, ORG_ID),
    );
  });

  it("two orgs do not collide for the same pair", () => {
    expect(getDmChannelId(CUID_A, CUID_B, "org-one")).not.toBe(
      getDmChannelId(CUID_A, CUID_B, "org-two"),
    );
  });

  it("stays inside Stream's 64-character ceiling", () => {
    for (const id of [
      getDmChannelId(CUID_A, CUID_B),
      getDmChannelId(CUID_A, CUID_B, ORG_ID),
      getDmChannelId(UUID_A, UUID_B),
      getDmChannelId(UUID_A, UUID_B, ORG_ID),
    ]) {
      expect(id.length).toBeLessThanOrEqual(64);
    }
  });
});

describe("event channels are untouched by the DM prefixes", () => {
  it("still resolves webinar and class ids to team", () => {
    expect(getChannelTypeFromId("webinar-abc123")).toBe("team");
    expect(getChannelTypeFromId("class-abc123")).toBe("team");
  });

  it("does not treat a webinar as a DM", () => {
    expect(isDMChannel("webinar-abc123")).toBe(false);
  });
});

describe("self-pairs are refused rather than collapsed", () => {
  it("throws instead of deriving dm-<a>-<a>", () => {
    // `createChannel` de-duplicates its member array through a Set, so a
    // self-pair produced a one-member `messaging` channel: no counterparty to
    // render, so the header fell through to the raw id, and no second member
    // to reply. Refusing at derivation is what stops that reaching Stream.
    expect(() => getDmChannelId(CUID_A, CUID_A)).toThrow(/self-DM/i);
    expect(() => getDmChannelId(CUID_A, CUID_A, ORG_ID)).toThrow(/self-DM/i);
  });
});
