/**
 * @jest-environment node
 */

/**
 * Four call sites compute a DM channel id, and every one of them has to agree
 * with the creators in `actions/stream/chat/channel.action.ts` — they are
 * recomputing an id those creators already used, so any divergence points at a
 * channel that does not exist.
 *
 * The creators resolve context as:
 *
 *     plan.organizationId ?? appointment.organizationId ?? null
 *
 * Two genuinely distinct cases sit behind that `??`: a plan can be org-HOSTED
 * while the booking is self-funded, and a personal plan can be booked through an
 * org-funded membership. Review found three consumers reading only the
 * appointment, which treated every org-hosted-plan booking as personal. The
 * reconcile set then looked for `dm-<a>-<b>` while the real channel was `dmo-…`
 * — never re-joined at best, and at worst treated as stale so the user was
 * removed from their own conversation.
 *
 * These assertions are source-level because the point is which expression each
 * site uses, not what a mocked Prisma row would return.
 */

import { readFileSync } from "fs";
import { join } from "path";

import {
  bookingOrgId,
  getDmChannelId,
  STREAM_CHANNEL_ID_MAX,
} from "@/lib/stream-utils";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/**
 * This block used to assert that each consumer file CONTAINED a particular `??`
 * chain. Matching source text could only ever see the shape of the expression,
 * so it missed the divergence that actually mattered — every site agreed on the
 * precedence, while the creators filtered `appointments` to org-tagged rows and
 * the consumers read an unordered `[0]` — and it broke the moment the
 * duplication it was policing was removed. Behaviour first now, with a much
 * narrower drift guard behind it.
 */
describe("bookingOrgId — the one resolver every DM key goes through", () => {
  it("puts the plan's org ahead of the appointment's", () => {
    expect(
      bookingOrgId({
        consultationPlan: { organizationId: "org_plan" },
        appointment: { organizationId: "org_appointment" },
      }),
    ).toBe("org_plan");
  });

  it("falls back to the appointment when the plan is personal", () => {
    expect(
      bookingOrgId({
        consultationPlan: { organizationId: null },
        appointment: { organizationId: "org_appointment" },
      }),
    ).toBe("org_appointment");
  });

  it("resolves null when nothing is org-funded", () => {
    expect(
      bookingOrgId({
        subscriptionPlan: { organizationId: null },
        appointments: [{ organizationId: null }],
      }),
    ).toBeNull();
  });

  // THE regression this helper exists to close. `createSubscriptionChannel`
  // reads `where: { organizationId: { not: null } }, take: 1`, so it saw the
  // org-tagged row and minted `dmo-…`. Every consumer read `appointments[0]`
  // from a result with no `where` and no `orderBy`, so a mixed subscription
  // resolved `null` and looked for `dm-…`. Same pair, two channels, and the
  // reconciler then treated the real one as stale.
  it("finds the org-tagged appointment even when it is not first", () => {
    expect(
      bookingOrgId({
        subscriptionPlan: { organizationId: null },
        appointments: [
          { organizationId: null },
          { organizationId: "org_funded" },
        ],
      }),
    ).toBe("org_funded");
  });

  it("agrees with the creator's filtered read on a mixed subscription", () => {
    const mixed = [{ organizationId: null }, { organizationId: "org_funded" }];
    // What the creator's query hands it: org-tagged rows only, capped at one.
    const creatorSaw = mixed.filter((a) => a.organizationId).slice(0, 1);
    expect(bookingOrgId({ appointments: mixed })).toBe(
      bookingOrgId({ appointments: creatorSaw }),
    );
  });

  it("ignores an empty appointment list", () => {
    expect(bookingOrgId({ appointments: [] })).toBeNull();
    expect(bookingOrgId({})).toBeNull();
  });
});

describe("no site re-types the precedence chain", () => {
  const CONSUMERS: [string, string][] = [
    ["creators", "actions/stream/chat/channel.action.ts"],
    ["reconcile", "actions/stream/chat/event-channel.action.ts"],
    ["webhook", "lib/payments/webhooks/ensure-channels.ts"],
    [
      "consultation approval",
      "app/api/bookings/consultations/[consultationId]/route.ts",
    ],
    [
      "subscription approval",
      "app/api/bookings/subscriptions/[subscriptionId]/route.ts",
    ],
    ["search", "app/api/stream/channels/search-appointments/route.ts"],
    ["backfill", "scripts/stream/backfill-channel-org.ts"],
  ];

  it.each(CONSUMERS)("%s calls the helper", (_label, rel) => {
    expect(read(rel)).toContain("bookingOrgId");
  });

  it.each(CONSUMERS)("%s has not drifted back to a local chain", (_label, rel) => {
    const src = read(rel);
    expect(src).not.toContain("consultationPlan?.organizationId ??");
    expect(src).not.toContain("subscriptionPlan?.organizationId ??");
    expect(src).not.toContain("consultationPlan.organizationId ??");
    expect(src).not.toContain("subscriptionPlan.organizationId ??");
  });

  it.each([
    ["creators", "actions/stream/chat/channel.action.ts"],
    ["reconcile", "actions/stream/chat/event-channel.action.ts"],
    ["search", "app/api/stream/channels/search-appointments/route.ts"],
    ["webhook", "lib/payments/webhooks/ensure-channels.ts"],
    [
      "subscription approval",
      "app/api/bookings/subscriptions/[subscriptionId]/route.ts",
    ],
  ])("%s reads appointments in a deterministic order", (_label, rel) => {
    // Filtering alone is not enough. `take: 1` over an unordered result, or a
    // `find` over one, can hand two callers different rows if a subscription
    // ever carries two org-tagged appointments — the same divergence this whole
    // file exists to close, one layer down.
    expect(read(rel)).toContain('orderBy: [{ createdAt: "asc" }, { id: "asc" }]');
  });

  it.each([
    ["creators", "actions/stream/chat/channel.action.ts"],
    ["reconcile", "actions/stream/chat/event-channel.action.ts"],
    ["search", "app/api/stream/channels/search-appointments/route.ts"],
  ])("%s filters its take:1 appointment read", (_label, rel) => {
    // `take: 1` truncates server-side, before bookingOrgId's `find` can run. A
    // site that caps without filtering hands the helper a personal row and
    // resolves `null` for a subscription that IS org-funded.
    expect(read(rel)).toContain("where: { organizationId: { not: null } }");
  });
});

describe("channel ids stay inside Stream's cap without throwing", () => {
  const CUID_A = "cmqb1757m005stxyoe218odf1";
  const CUID_B = "cmqb190qa00hotxyor367yjz1";
  const UUID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const UUID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  it("leaves ordinary personal ids byte-identical, so no channel moves", () => {
    expect(getDmChannelId(CUID_A, CUID_B)).toBe(`dm-${CUID_A}-${CUID_B}`);
  });

  it("is order-independent", () => {
    expect(getDmChannelId(CUID_B, CUID_A)).toBe(getDmChannelId(CUID_A, CUID_B));
  });

  it("degrades legacy uuid pairs instead of throwing", () => {
    // `dm-<36>-<36>` is 76 chars. Throwing here rejected the whole
    // reconciliation — `getDmPairsForUser` and the `expectedChannelIds` map are
    // not wrapped per-item — so one legacy account broke channel sync for
    // everyone paired with it.
    expect(`dm-${UUID_A}-${UUID_B}`.length).toBeGreaterThan(
      STREAM_CHANNEL_ID_MAX,
    );

    const id = getDmChannelId(UUID_A, UUID_B);
    expect(id.startsWith("dmh-")).toBe(true);
    expect(id.length).toBeLessThanOrEqual(STREAM_CHANNEL_ID_MAX);
    // Deterministic, or the fallback would strand the conversation.
    expect(getDmChannelId(UUID_B, UUID_A)).toBe(id);
  });

  it("keeps the three namespaces distinct", () => {
    const personal = getDmChannelId(CUID_A, CUID_B);
    const org = getDmChannelId(CUID_A, CUID_B, "org-1");
    const legacy = getDmChannelId(UUID_A, UUID_B);

    expect(new Set([personal, org, legacy]).size).toBe(3);
    expect(org.startsWith("dmo-")).toBe(true);
  });

  it("separates two orgs for the same pair, with room to spare", () => {
    const a = getDmChannelId(CUID_A, CUID_B, "org-1");
    const b = getDmChannelId(CUID_A, CUID_B, "org-2");
    expect(a).not.toBe(b);

    // The org segment is the ONLY differentiator between two orgs' otherwise
    // identical pair digest, so a collision would merge two organizations' DM
    // threads. 8 hex chars was 32 bits; this is 64.
    const orgSegment = a.split("-")[1];
    expect(orgSegment).toHaveLength(16);
    expect(a.length).toBeLessThanOrEqual(STREAM_CHANNEL_ID_MAX);
  });
});

/**
 * #1134 P0-3 — the id must not depend on the runtime's collation.
 *
 * `getDmChannelId` sorted the pair with `localeCompare`, which orders by ICU
 * collation: case-insensitive at the primary level, and dependent on both the
 * ICU build and the default locale. Better Auth ids are mixed-case and cuids are
 * lowercase, so commit 01162093 — a "standardize the conventions" refactor that
 * swapped `.sort()` for `.sort(localeCompare)` — silently re-keyed most pairs.
 * Their history stayed on the old channel while a new empty one took its place,
 * and both were still live in the Stream app months later.
 *
 * The ids below are synthetic but mirror the production SHAPES exactly — a
 * 32-char mixed-case Better Auth id and a 25-char lowercase cuid — and they are
 * chosen so the two orderings genuinely disagree, which is the whole premise of
 * this test. Real production ids used to sit here; they are user identifiers and
 * do not belong in a public repository.
 */
describe("DM ids are collation-independent", () => {
  const BETTER_AUTH_ID = "KpVxWqMbTnJcRdLsHfGyZaEuNiOtBwXk";
  const CUID = "ckzq7x1a20000t3lbe9f4h2mv";

  it("is symmetric regardless of argument order", () => {
    expect(getDmChannelId(BETTER_AUTH_ID, CUID)).toBe(
      getDmChannelId(CUID, BETTER_AUTH_ID),
    );
  });

  it("orders by code unit, not by locale collation", () => {
    // Guard the premise: if these ever stop disagreeing the test proves nothing.
    expect(BETTER_AUTH_ID.localeCompare(CUID) < 0).not.toBe(
      BETTER_AUTH_ID < CUID,
    );

    expect(getDmChannelId(BETTER_AUTH_ID, CUID)).toBe(
      `dm-${BETTER_AUTH_ID}-${CUID}`,
    );
  });

  it("does not vary with the process locale", () => {
    // A machine set to tr-TR dot-less-i, or a Node built with small-icu, must
    // still produce the same channel as every other deployment.
    const base = getDmChannelId(BETTER_AUTH_ID, CUID);
    for (const locale of ["tr-TR", "en-US", "de-DE", "sv-SE"]) {
      const [a, b] = [BETTER_AUTH_ID, CUID].sort((x, y) =>
        x.localeCompare(y, locale),
      );
      // Whatever that locale would have produced, the real id is unchanged.
      expect(getDmChannelId(a, b)).toBe(base);
      expect(getDmChannelId(b, a)).toBe(base);
    }
  });

  it("is symmetric for the org-scoped form too", () => {
    expect(getDmChannelId(BETTER_AUTH_ID, CUID, "org_1")).toBe(
      getDmChannelId(CUID, BETTER_AUTH_ID, "org_1"),
    );
    expect(getDmChannelId(BETTER_AUTH_ID, CUID, "org_1")).not.toBe(
      getDmChannelId(BETTER_AUTH_ID, CUID),
    );
  });
});
