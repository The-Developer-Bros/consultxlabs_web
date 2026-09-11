import { z } from "zod";

/**
 * Response shapes for the two Stream search endpoints.
 *
 * These used to be `export type` declarations inside the route handlers, which
 * meant `components/chat/*` imported them from `@/app/api/...` — pointing the
 * routing layer's way instead of away from it. Type-only, so nothing broke at
 * runtime, but it makes those components impossible to reason about or extract
 * without dragging `app/` along.
 *
 * Zod rather than a plain interface in `types/`: both handlers parse their
 * results against these schemas on the way out, and both consumers derive their
 * types from the same definitions. So the two agree by construction rather than
 * by one asserting a shape the other hopes is true — a field renamed in a
 * handler fails at the boundary instead of arriving as `undefined` in the UI,
 * which is the exact class of drift that put ₹NaN on two money tables in
 * #1029.
 */

/** The four bookable kinds, shared by both searches. */
export const StreamSearchKindSchema = z.enum([
  "consultation",
  "subscription",
  "webinar",
  "class",
]);

export const AppointmentSearchResultSchema = z.object({
  id: z.string(),
  type: StreamSearchKindSchema,
  name: z.string(),
  /**
   * The OTHER party, relative to the caller — not the consultant.
   *
   * These replace `consultantName`/`consultantImage`, which named the
   * consultant unconditionally. On a consultant's own dashboard that is the
   * consultant themselves, so every row in their search read as a conversation
   * with themselves. The name is now resolved per-caller in the handler.
   *
   * For a group event there is no single counterparty, so this is the host.
   */
  counterpartyName: z.string(),
  counterpartyImage: z.string().optional(),
  /**
   * Present only for 1:1 rows. The client sends this to
   * `POST /api/stream/channels/open`, which re-derives the channel id
   * server-side — the id below is for display and cache lookup, never the
   * authority on which channel gets opened.
   */
  counterpartyUserId: z.string().optional(),
  /** Funding context, part of the DM key. Null/absent = personal. */
  organizationId: z.string().nullable().optional(),
  channelId: z.string(),
});

export const ConsulteeSearchResultSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
  relationshipType: StreamSearchKindSchema,
});

export type AppointmentSearchResult = z.infer<
  typeof AppointmentSearchResultSchema
>;
export type ConsulteeSearchResult = z.infer<typeof ConsulteeSearchResultSchema>;
