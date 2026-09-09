import { createHash } from "node:crypto";

/**
 * Stream caps channel ids at 64 characters. Nothing used to check that, and we
 * are closer to the ceiling than anyone realised: a seeded cuid pair already
 * produces 54 characters and the longest live channel measured 61. Two users on
 * 36-character uuid ids — 17 accounts carry them — would produce 76 and be
 * rejected by Stream at runtime, silently, because the create action's
 * `channelIdSchema` only asserts `min(1)`.
 */
export const STREAM_CHANNEL_ID_MAX = 64;

/** Short, stable digest. Hex, so the result is always `[a-f0-9]` — Stream-safe. */
function digest(value: string, chars: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, chars);
}

/**
 * Personal ids are `dm-<a>-<b>`, which fits comfortably for cuid users (54–61
 * chars) but NOT for the 17 accounts still on 36-char uuids: two of those
 * produce 76 chars.
 *
 * Throwing there was wrong. `getDmPairsForUser` and the `expectedChannelIds`
 * map in `syncUserEventChannels` call this synchronously and un-isolated —
 * unlike the add-pass, which is wrapped in `Promise.allSettled` — so a single
 * legacy-id pair would reject the whole reconciliation and break channel sync
 * for everyone paired with that account. Before the guard existed the same call
 * simply produced a long id and failed later at the Stream API, affecting one
 * channel rather than the run.
 *
 * So it degrades instead: a deterministic hashed form under a distinct prefix.
 * Same input, same id, every time — and no id already in use changes, because
 * every existing channel is under the cap.
 */
function fitOrHash(channelId: string, hashInput: string): string {
  if (channelId.length <= STREAM_CHANNEL_ID_MAX) return channelId;
  // `dmh-` keeps this namespace distinct from both `dm-` and `dmo-`.
  return `dmh-${digest(hashInput, 40)}`;
}

/**
 * Deterministic Stream channel id for a consultant–consultee DM.
 *
 * A DM used to be keyed on the pair alone, which made the channel the
 * RELATIONSHIP rather than the booking: the same two people had one thread no
 * matter how many sessions they booked or who funded them, and it carried the
 * org tag of whichever booking happened to create it. ADR 19 splits dashboards
 * by org-ness, so that single thread could not land in the right place — a pair
 * who work both B2C and through an org had one conversation belonging in two
 * dashboards. The org is now part of the key, so a pair gets one thread per
 * context.
 *
 * The two forms are deliberately different shapes rather than one scheme with an
 * appended segment:
 *
 *   personal   `dm-<a>-<b>`              54–61 chars, byte-identical to before
 *   org        `dmo-<org8>-<pair16>`     29 chars
 *
 * Personal ids are unchanged, so every existing conversation keeps its channel —
 * and there was no headroom to extend them in any case (61 of 64). The org form
 * hashes both halves precisely because appending anything to the pair would have
 * overflowed. Verified before shipping that zero org-tagged channels existed, so
 * nothing needed migrating.
 *
 * Opaque ids are the cost. Debugging goes through the channel's members and its
 * `organization_id` custom field, both set at creation.
 */
export function getDmChannelId(
  userId1: string,
  userId2: string,
  organizationId?: string | null,
): string {
  // A pair of one is not a pair. `createChannel` de-duplicates its member array
  // through a Set, so `[a, a]` silently collapsed to a one-member `messaging`
  // channel that rendered as its own raw id (channelUtils has no branch for
  // zero counterparties) and that nothing could ever reply in. Checkout already
  // refuses self-booking, so reaching here with a self-pair means a caller
  // resolved the two sides wrongly — which is worth a stack trace, not a
  // channel. Callers that iterate over untrusted pair lists must filter first;
  // `getDmPairsForUser` does.
  if (userId1 === userId2) {
    throw new Error(
      `getDmChannelId: refusing to derive a self-DM id for ${userId1}`,
    );
  }

  // Code-unit ordering, NOT localeCompare. #1134 P0-3: localeCompare sorts by
  // ICU collation — case-insensitive at the primary level and dependent on the
  // runtime's ICU build and default locale — so the same pair yielded different
  // ids in different environments. Better Auth ids are mixed-case and cuids are
  // lowercase, so when 01162093 switched `.sort()` to `.sort(localeCompare)` it
  // silently re-keyed most pairs and orphaned their history behind a new empty
  // channel. Both variants were still live months later. Pinned by
  // __tests__/security/dm-channel-org-precedence.test.ts.
  const [a, b] = userId1 < userId2 ? [userId1, userId2] : [userId2, userId1];

  if (!organizationId) {
    return fitOrHash(`dm-${a}-${b}`, `${a}-${b}`);
  }

  // Hash the pair, not only the org: the pair is the long part, and the point is
  // to stay well inside the ceiling rather than creep back up to it.
  //
  // 16 and 24 hex chars — 64 and 96 bits. The org segment is the ONLY thing
  // separating two organizations' otherwise-identical pair digest, so a
  // collision there would merge two orgs' DM threads for the same pair. At 8
  // chars (32 bits) the birthday bound makes that non-trivial in the tens of
  // thousands of orgs; at 64 bits it is not a concern. The format still uses
  // only 45 of the 64 available characters.
  return `dmo-${digest(organizationId, 16)}-${digest(`${a}-${b}`, 24)}`;
}

/**
 * The org context a DM channel was created under — the second half of the key
 * `getDmChannelId` builds, and the half that has repeatedly gone wrong.
 *
 * Precedence is plan-before-appointment, because these are two distinct cases: a
 * plan can be org-HOSTED while the booking is self-funded, and a personal plan
 * can be booked through an org-funded membership. Reading only the appointment
 * treated every org-hosted-plan booking as personal, so the reconcile set looked
 * for `dm-<a>-<b>` while the real channel was `dmo-…`. At best the user was
 * never re-joined; at worst the real channel was classified stale and they were
 * removed from it.
 *
 * This lived privately in event-channel.action.ts while eight sites hand-rolled
 * the same `??` chain (#1134 P0-8). The chain was identical everywhere; what
 * diverged was the SELECTION. `createSubscriptionChannel` reads the first
 * appointment carrying an org (`where: { organizationId: { not: null } }`),
 * while every consumer read `appointments[0]` from an unordered result — so a
 * subscription mixing org-funded and personal appointments got `dmo-…` from the
 * creator and `dm-…` from approval and the reconciler. Hence `find`, not `[0]`:
 * it converges every caller on the creator's semantics without those callers
 * having to remember the filter. Queries that additionally `take: 1` still need
 * the `where`, because the truncation happens server-side before `find` runs.
 *
 * A subscription carries many appointments but is funded once, so the first
 * org-tagged one is representative.
 */
export function bookingOrgId(booking: {
  consultationPlan?: { organizationId: string | null } | null;
  subscriptionPlan?: { organizationId: string | null } | null;
  // #1280 PR 7 — event plans too. The precedence is the same rule (plan first,
  // then appointment) and the point of this helper is that there is exactly ONE
  // answer to "which org funded this". A second resolver for webinars and
  // classes is how the org tag came to disagree between the creator, approval
  // and the reconciler in the first place.
  webinarPlan?: { organizationId: string | null } | null;
  classPlan?: { organizationId: string | null } | null;
  appointment?: { organizationId: string | null } | null;
  appointments?: { organizationId: string | null }[];
}): string | null {
  return (
    booking.consultationPlan?.organizationId ??
    booking.subscriptionPlan?.organizationId ??
    booking.webinarPlan?.organizationId ??
    booking.classPlan?.organizationId ??
    booking.appointment?.organizationId ??
    smallestOrgId(booking.appointments) ??
    null
  );
}

/**
 * The org id a set of appointments resolves to, deterministically.
 *
 * #1304 review — `find()` returns whichever tagged row the relation happened to
 * yield first, and Prisma relations come back unordered. If two appointments
 * carry DIFFERENT orgs the answer changes between reads, and since the DM
 * channel id is a function of the org, one relationship would mint
 * `dmo-<digest(A)>` on one path and `dmo-<digest(B)>` on another — two channels,
 * split history. That is the same shape as the `[0]`-vs-`find` bug this helper
 * was written to fix; `find` closed the null-versus-org half and left this one.
 *
 * Fixed here rather than by adding `orderBy` to each query, because there are
 * several callers and the ones that forgot would keep the bug. Code-unit
 * ordering, never `localeCompare` — the same rule as the channel ids, and for
 * the same reason: an ICU-dependent comparison would make the derived channel
 * id environment-dependent.
 *
 * A booking is funded once, so in a well-formed dataset there is at most one
 * distinct org here and any choice is the same choice. This only decides what
 * happens when that invariant is violated, and a stable wrong answer is
 * recoverable where an unstable one is not.
 */
function smallestOrgId(
  appointments: { organizationId: string | null }[] | undefined,
): string | undefined {
  let smallest: string | undefined;
  for (const appointment of appointments ?? []) {
    const org = appointment.organizationId;
    if (org && (smallest === undefined || org < smallest)) smallest = org;
  }
  return smallest;
}

/**
 * Belt-and-braces detector for a duplicate-channel rejection so concurrent
 * create-on-miss paths can ADOPT the winner's channel instead of failing the
 * user journey (architecture review F-HIGH-3).
 *
 * Deliberately NARROW (message text only). Stream's official API error table
 * defines no "already exists" code — code 17 is `Not Allowed Error` (HTTP 403)
 * and v9's channel.create() is an idempotent get-or-create via the /query
 * endpoint, so duplicates normally RESOLVE rather than reject. Matching by
 * code or status would misclassify documented failures (notably 17/403) as
 * benign races and silently skip creation. Only an error whose text names the
 * collision is treated as adoptable; anything else propagates.
 */
export function isChannelAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /already exists/i.test(error.message);
}
