/**
 * #1134 P1-20 — Stream's per-request ceilings, in one place.
 *
 * Every bulk call in this codebase passed the whole array straight through:
 * `upsertUsers(allMembers)` and `channel.create({ members: allMembers })` with
 * no slicing anywhere. `WebinarPlan.maxParticipants` defaults to 100 and
 * `Webinar.maxParticipants` is unbounded, so a lazy channel create for a large
 * webinar sent an oversized request, threw, and landed in a catch that (before
 * #1136) did not even reach Sentry — the attendee silently got no chat.
 *
 * Stream documents 100 as the limit for all three of the calls we make:
 *   upsertUsers            — 100 users per request
 *   addMembers/removeMembers — 100 members per request
 *   deleteChannels         — 100 channels per request
 */
export const STREAM_BATCH_LIMIT = 100;

/**
 * Fan-out width for operations Stream gives us NO bulk endpoint for.
 *
 * Deliberately separate from `STREAM_BATCH_LIMIT`, which is a PAYLOAD ceiling —
 * how many items fit inside one request. Freezing a channel has no bulk form, so
 * it is one request per channel; chunking those by 100 and awaiting the chunk
 * fires a hundred simultaneous requests, which is precisely the shape the note
 * on `forEachChunk` below warns about. The two numbers answer different
 * questions and only coincidentally started out the same.
 *
 * Ten is a conservative fan-out rather than a figure derived from a published
 * per-second quota; Stream documents the per-request ceilings above but not a
 * concurrency limit we can point at. Being wrong low costs a slower background
 * job, being wrong high costs 429s on live user traffic sharing the app.
 */
export const STREAM_CONCURRENCY_LIMIT = 10;

/**
 * Pause between concurrency-limited batches, so a chunked per-item loop
 * (freeze/unfreeze — the `UpdateChannelPartial` endpoint) averages under this
 * many requests per minute even when Stream answers instantly.
 *
 * 140 is roughly HALF of Stream's app-wide 300/min cap for that endpoint: each
 * paced consumer stays under half the budget, so two independent consumers —
 * the daily expire cron on GitHub Actions and a maintenance drain on Netlify,
 * which cannot share an in-process limiter — cannot jointly breach 300/min
 * even if their windows overlap. Concurrency width alone does NOT give you
 * this: ten parallel calls answered in 100ms is ~6000 req/min.
 */
export const STREAM_TARGET_REQUESTS_PER_MINUTE = 140;

export const STREAM_BATCH_PAUSE_MS = Math.ceil(
  (STREAM_CONCURRENCY_LIMIT * 60_000) / STREAM_TARGET_REQUESTS_PER_MINUTE,
);

/** Sleep for `ms` milliseconds. Trivial, but keeps call sites readable. */
export function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Split into chunks of at most `size`. Empty input yields no chunks. */
export function chunk<T>(items: T[], size: number = STREAM_BATCH_LIMIT): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunk size must be a positive integer, got ${size}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Run `fn` over each chunk in sequence.
 *
 * Sequential on purpose: Stream rate-limits per app, so firing twenty chunks
 * concurrently to shave latency off one webinar create is how you 429 every
 * other request in flight. These paths are all background or one-off.
 */
export async function forEachChunk<T>(
  items: T[],
  fn: (batch: T[], index: number) => Promise<void>,
  size: number = STREAM_BATCH_LIMIT,
): Promise<void> {
  const batches = chunk(items, size);
  for (let i = 0; i < batches.length; i++) {
    await fn(batches[i], i);
  }
}

/**
 * How many channels `queryChannels` actually returns, per call.
 *
 * #1270 — Stream caps this response at 30 regardless of the `limit` you pass;
 * asking for 100 returns exactly 30. Two reconciliation call sites paged with
 * `do … while (page.length === 100)`, so the loop saw 30, decided the roster
 * was exhausted and exited after ONE page — and the `offset += 100` it used to
 * advance would have skipped 70 channels had it ever looped. A stale DM sitting
 * at position 41 of a user's membership list was therefore never classified
 * stale and never revoked. `scripts/stream/purge-memberless-dms.ts` learned
 * this first; the constant now lives here so nothing relearns it a third time.
 */
export const STREAM_QUERY_CHANNELS_LIMIT = 30;

/**
 * The largest `offset` Stream will accept on `queryChannels`.
 *
 * Offset paging therefore tops out a little past a thousand channels and there
 * is no cursor for this endpoint to continue with. Going deeper means
 * re-querying under a moving `last_message_at` bound, which a membership
 * reconciler cannot do safely: it sorts by nothing in particular, a channel's
 * `last_message_at` changes underneath the walk, and a page boundary that
 * shifts mid-walk hides channels rather than repeating them. So we stop, and
 * we say so — `queryChannelsPaged` reports `truncated` instead of quietly
 * handing back a short list that a caller would read as "this is everything".
 */
export const STREAM_QUERY_CHANNELS_MAX_OFFSET = 1000;

/**
 * Walk every page of a `queryChannels` filter.
 *
 * Generic over the page type and agnostic about how the request is made, so a
 * caller can wrap its own fetch in the Stream circuit breaker (or not) without
 * this helper needing to know about either.
 *
 * `truncated` is true only when Stream's offset ceiling stopped the walk, which
 * means the result is a prefix of the real answer. It is never true just
 * because the caller has few channels.
 */
export async function queryChannelsPaged<T>(
  fetchPage: (opts: { limit: number; offset: number }) => Promise<T[]>,
): Promise<{ channels: T[]; truncated: boolean }> {
  const channels: T[] = [];
  let offset = 0;

  for (;;) {
    const page = await fetchPage({
      limit: STREAM_QUERY_CHANNELS_LIMIT,
      offset,
    });
    channels.push(...page);

    // Advance by what came BACK, not by what was asked for. These differ
    // whenever Stream trims the page, and treating them as equal is what
    // silently skipped channels before #1270.
    offset += page.length;

    // A short page is the end of the list. A full page at the offset ceiling
    // is the end of what Stream will serve.
    if (page.length < STREAM_QUERY_CHANNELS_LIMIT) {
      return { channels, truncated: false };
    }
    if (offset > STREAM_QUERY_CHANNELS_MAX_OFFSET) {
      return { channels, truncated: true };
    }
  }
}

/** The subset of a Stream channel `addRemainingMembers` needs. */
interface MemberAddable {
  addMembers: (memberIds: string[]) => Promise<unknown>;
}

/**
 * The members that fit in the atomic `channel.create()` call.
 *
 * #1270 — `create()` carries its roster in the request body and is bound by the
 * same 100-member ceiling as `addMembers`, so a 150-seat webinar's first
 * attendee to open chat got a rejected create and no chat at all. Whoever must
 * definitely end up in the channel — the creator, and the person whose join
 * triggered the create — belongs at the FRONT of `members` so they land in this
 * chunk rather than in a follow-up request that could fail on its own.
 */
export function createMemberChunk(members: string[]): string[] {
  return members.slice(0, STREAM_BATCH_LIMIT);
}

/**
 * Add everyone `createMemberChunk` left behind, 100 at a time.
 *
 * A no-op for the overwhelming majority of channels, which have two members.
 */
export async function addRemainingMembers(
  channel: MemberAddable,
  members: string[],
): Promise<void> {
  await forEachChunk(members.slice(STREAM_BATCH_LIMIT), async (batch) => {
    await channel.addMembers(batch);
  });
}
