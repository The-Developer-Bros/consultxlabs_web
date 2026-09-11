/**
 * DPDP (Digital Personal Data Protection Act 2023) — canonical consent
 * purpose-code taxonomy. SINGLE source of truth for every code stored on a
 * `ConsentArtifact.purposeCodes[]` and every `checkConsent` gate.
 *
 * Why one taxonomy: DPDP §6 requires consent to be specific (not bundled) and
 * revocable, and Rule 3 requires an itemised, plain-language purpose notice.
 * The data fiduciary (this app, the controller) defines the purposes; the
 * processor (Stream.io) must act within them. Two parallel taxonomies — the
 * runtime UPPER_SNAKE gate vs. the org-UI kebab-case toggles — meant a user
 * could withdraw "third-party-sharing-with-stream" in the UI without ever
 * touching the STREAM_DATA_PROCESSING code the gate reads, and had no UI path
 * to re-grant it. The UPPER_SNAKE side wins because the fail-closed gate
 * already depends on it; the kebab-case codes were dashboard-only and never
 * consulted at runtime.
 *
 * NOTE: kept independent of dpdp.ts (no Prisma import) so it can be imported
 * from server actions, route handlers, client components, and the seed alike
 * without dragging the Prisma client into the client bundle.
 */

export const PURPOSE_CODES = {
  /** Core service/account processing required to deliver the platform. */
  PRIMARY_PROCESSING: "PRIMARY_PROCESSING",
  /** Handoff of user PII to Stream.io for video/chat (third-party processor). */
  STREAM_DATA_PROCESSING: "STREAM_DATA_PROCESSING",
  /** Marketing/promotional communications. */
  MARKETING_COMMS: "MARKETING_COMMS",
  /** Product/usage analytics. */
  ANALYTICS: "ANALYTICS",
  /** Booking/scheduling of consultation sessions. */
  SESSION_BOOKING: "SESSION_BOOKING",
} as const;

export type PurposeCode = (typeof PURPOSE_CODES)[keyof typeof PURPOSE_CODES];

/** Every canonical code as a flat array (e.g. for zod enums, UI lists). */
export const ALL_PURPOSE_CODES = Object.values(PURPOSE_CODES) as PurposeCode[];

/**
 * Human-readable labels + descriptions for the org consent dashboard. The
 * description doubles as the itemised purpose text DPDP Rule 3 requires the
 * notice to carry.
 */
export const PURPOSE_CODE_META: Record<
  PurposeCode,
  { label: string; description: string }
> = {
  [PURPOSE_CODES.PRIMARY_PROCESSING]: {
    label: "Service & account",
    description:
      "Process your data to create and run your account and deliver the platform's core features.",
  },
  [PURPOSE_CODES.SESSION_BOOKING]: {
    label: "Session booking",
    description:
      "Schedule, manage, and run consultation sessions you book or are booked into.",
  },
  [PURPOSE_CODES.STREAM_DATA_PROCESSING]: {
    label: "Video & chat (Stream.io)",
    description:
      "Share the data needed for live video and chat with our messaging processor (Stream.io). Required for video/chat to work.",
  },
  [PURPOSE_CODES.MARKETING_COMMS]: {
    label: "Marketing communications",
    description:
      "Send you marketing and promotional messages about products and offers.",
  },
  [PURPOSE_CODES.ANALYTICS]: {
    label: "Analytics",
    description: "Use your usage data to measure and improve the product.",
  },
} as const;

/**
 * Migration map from the legacy kebab-case dashboard taxonomy to the canonical
 * codes. Retained so any historical artifacts (or external callers still
 * sending the old strings) can be normalised on read/write. The DB itself is
 * NOT backfilled here (pre-MVP reset coming); this is the lookup table.
 */
export const LEGACY_PURPOSE_CODE_MAP: Record<string, PurposeCode> = {
  "session-booking": PURPOSE_CODES.SESSION_BOOKING,
  "marketing": PURPOSE_CODES.MARKETING_COMMS,
  "analytics": PURPOSE_CODES.ANALYTICS,
  "third-party-sharing-with-stream": PURPOSE_CODES.STREAM_DATA_PROCESSING,
  "account-management": PURPOSE_CODES.PRIMARY_PROCESSING,
};

/** Canonical-code membership set, for O(1) "is this already canonical?" checks. */
const CANONICAL_PURPOSE_CODE_SET = new Set<PurposeCode>(ALL_PURPOSE_CODES);

/**
 * Normalise a possibly-legacy purpose code to its canonical form. Returns
 * `undefined` for codes that are neither a known legacy alias nor already
 * canonical — callers MUST drop/reject those rather than storing them, so
 * non-canonical strings can never re-enter the taxonomy and recreate drift.
 */
export function normalizePurposeCode(code: string): PurposeCode | undefined {
  const mapped = LEGACY_PURPOSE_CODE_MAP[code];
  if (mapped) return mapped;
  return CANONICAL_PURPOSE_CODE_SET.has(code as PurposeCode)
    ? (code as PurposeCode)
    : undefined;
}

/**
 * Reverse of `normalizePurposeCode`: every string an artifact may legitimately
 * be STORED under for a given canonical code — the canonical code itself plus
 * each legacy alias that normalises to it.
 *
 * #1472 — the runtime gates matched the canonical code exactly, so an artifact
 * written under the pre-taxonomy kebab-case code (`session-booking`) was
 * invisible to them and every booking against that consultant answered 403
 * although `withdrawnAt` was null. A consent record is a legal artifact: the
 * gate has to recognise every code the platform ever wrote, so reads go through
 * `hasSome: purposeCodeAliases(code)` rather than `has: code`. Writes still
 * normalise to the canonical form, and the DB is deliberately NOT backfilled
 * (pre-MVP reset).
 */
export function purposeCodeAliases(code: PurposeCode): string[] {
  const legacy = Object.keys(LEGACY_PURPOSE_CODE_MAP).filter(
    (alias) => LEGACY_PURPOSE_CODE_MAP[alias] === code,
  );
  return [code, ...legacy];
}
