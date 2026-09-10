import { z } from "zod";
import { UserRole } from "@prisma/client";
import { DateOfBirthSchema } from "@/lib/compliance/age";
import { OnboardingFormDataSchema } from "@/utils/onboarding";

/**
 * Shared contract for the resumable-onboarding draft row.
 *
 * This module is intentionally free of "server-only" imports so the wizard
 * (client), the draft server actions, and the tests can all speak the same
 * shapes. The Prisma side of the contract lives in prisma/schema.prisma
 * (`OnboardingDraft`) and is never imported here.
 *
 * Two asymmetric problems make a raw round-trip unsafe:
 *
 * 1. WRITE — wizard state contains non-JSON values. `verificationDocuments`
 *    transiently holds `File` instances while an upload is mid-flight, and
 *    functions/undefined sneak in via form-state spreads. The Prisma `Json`
 *    column rejects (or silently mangles) all three, so everything is
 *    sanitized through `sanitizeDraftValue` before persisting.
 *
 * 2. READ — JSON has no Date type. `dateOfBirth` must be a real `Date` by the
 *    time step schemas validate (#1132 age gate) and `OnboardingFormData`
 *    types `emailVerified` as `Date`, yet both come back as ISO strings.
 *    `reviveDraftDates` restores them without trusting the raw strings —
 *    each goes through a Zod schema before becoming a Date.
 *
 * 3. BOTH — the column is a `Json` blob the database enforces nothing about,
 *    and the wizard spreads whatever comes back straight into form state. So
 *    this module also owns the two guarantees the column cannot make:
 *    `OnboardingDraftPayloadSchema` (the key set is the wizard's key set, and
 *    arrays are arrays) and `ONBOARDING_DRAFT_PAYLOAD_VERSION` (a payload from
 *    an older wizard is quarantined, never half-merged into the new one).
 */

/** Hard ceiling on the serialized payload. A filled consultant form is ~15KB;
 *  this leaves generous headroom while capping abuse. */
export const ONBOARDING_DRAFT_MAX_BYTES = 64 * 1024;

/**
 * Payload-shape generation. Bump whenever a stored payload can no longer be
 * spread into fresh wizard state — a renamed or retyped field, a step split, a
 * registry reshuffle. The reader quarantines anything carrying a different
 * marker rather than merging half-compatible answers into the new form.
 *
 * Deliberately a payload key and not a column: it describes the blob, so it
 * must travel with the blob (a column could disagree with the bytes next to
 * it after a partial write, and a column would need a migration to add).
 */
export const ONBOARDING_DRAFT_PAYLOAD_VERSION = 1;

/** Where the marker lives inside the payload. */
export const ONBOARDING_DRAFT_VERSION_KEY = "__v";

/** Keys that must never survive into a stored payload regardless of nesting.
 *  `__proto__` and `constructor` are the two that turn a plain property write
 *  into a prototype mutation; `prototype` rides along for completeness. */
const POISONED_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Step indices are bounded by the largest registry (consultant = 5 steps);
 *  the bound exists to catch corrupt clients, not to track the registry. */
export const ONBOARDING_DRAFT_MAX_STEP = 16;

const IsoDateStringSchema = z
  .string()
  .refine(
    (value) => !Number.isNaN(Date.parse(value)),
    "Must be an ISO date string",
  );

/**
 * Accepts a Date or an ISO string and always yields a Date — mirrors how
 * DateOfBirthSchema handles the same ambiguity for the wizard itself.
 */
const RevivableDateSchema = z.union([
  z.date(),
  IsoDateStringSchema.transform((value) => new Date(value)),
]);

const DraftDateFieldsSchema = z
  .object({
    dateOfBirth: RevivableDateSchema.optional(),
    emailVerified: RevivableDateSchema.optional(),
  })
  .partial();

// ---------------------------------------------------------------------------
// Structural payload contract
// ---------------------------------------------------------------------------

/**
 * A draft holds answers that do not yet satisfy the real step schemas — that
 * is the whole point of a draft — so the payload contract is about SHAPE, not
 * validity. It asserts exactly three things:
 *
 *   1. The key set is the wizard's key set. Unknown keys are stripped, which
 *      is what stops `__proto__`/`constructor` from ever being stored and
 *      what stops keys from a retired wizard version accumulating forever in
 *      a row that is only ever read back whole.
 *   2. Every value is optional and otherwise untyped. A half-typed date, an
 *      empty string where a URL belongs, a partially-filled object — all
 *      legal mid-wizard.
 *   3. Anything the wizard treats as an array IS an array. This is the one
 *      structural promise consumers actually rely on: `subDomains.filter(…)`
 *      and `weeklySlots.map(…)` throw on a scalar, and they run during
 *      render, so a corrupt value takes the wizard down with no way back.
 *
 * The key set is derived from `OnboardingFormDataSchema` rather than listed
 * by hand, so a field added to a role branch is draftable the moment it
 * exists instead of being silently dropped until someone remembers this file.
 */
function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;
  // Bounded rather than `while (true)`: wrappers nest at most a few deep, and
  // a cycle here would hang module evaluation, not a request.
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodTypeAny;
    } else if (current instanceof z.ZodDefault) {
      current = current.removeDefault() as z.ZodTypeAny;
    } else if (current instanceof z.ZodEffects) {
      current = current.innerType() as z.ZodTypeAny;
    } else {
      return current;
    }
  }
  return current;
}

function buildDraftPayloadShape(): Record<string, z.ZodTypeAny> {
  // Per key: how many role branches declare it, and how many of those type it
  // as an array. A key only gets the array guard when EVERY branch declaring
  // it agrees — otherwise the guard would reject a legal value from the other
  // branch, and a draft must never lose data it could have kept.
  const declared = new Map<string, { branches: number; arrays: number }>();

  for (const branch of OnboardingFormDataSchema.options) {
    const shape = branch.shape as Record<string, z.ZodTypeAny>;
    for (const key of Object.keys(shape)) {
      // A wizard field named `__proto__` would defeat the whole exercise.
      if (POISONED_KEYS.has(key) || key === ONBOARDING_DRAFT_VERSION_KEY) {
        continue;
      }
      const tally = declared.get(key) ?? { branches: 0, arrays: 0 };
      tally.branches += 1;
      if (unwrapSchema(shape[key]) instanceof z.ZodArray) tally.arrays += 1;
      declared.set(key, tally);
    }
  }

  const built: Record<string, z.ZodTypeAny> = {};
  for (const [key, tally] of declared) {
    built[key] =
      tally.arrays === tally.branches
        ? z.array(z.unknown()).optional()
        : z.unknown().optional();
  }
  return built;
}

/** Stripping (Zod's default) rather than `.strict()`: an unknown key is a
 *  stale or hostile client, not a reason to throw away everything the user
 *  just typed. A non-array where an array belongs IS rejected — see above. */
export const OnboardingDraftPayloadSchema = z.object(buildDraftPayloadShape());

export interface OnboardingDraftSnapshot {
  role: UserRole | null;
  currentStep: number;
  payload: Record<string, unknown>;
  /** The stored payload was thrown away instead of restored — see
   *  `readStoredDraftPayload`. The wizard must say so rather than let the
   *  resume banner promise progress that is no longer there. */
  quarantined: boolean;
}

/** Wire shape of `saveOnboardingDraftAction`'s argument, validated with Zod
 *  because server-action parameters do not survive serialization typed.
 *
 *  Draft roles are narrowed to the PUBLIC flows. STAFF/ADMIN are invite-only
 *  and never render multi-step registries from this wizard; excluding them
 *  keeps the stored role forever incapable of looking like an authorization
 *  signal for a privileged surface. */
const DraftableRoleSchema = z.union([
  z.literal(UserRole.CONSULTANT),
  z.literal(UserRole.CONSULTEE),
  z.literal(UserRole.ORG_WORKSPACE),
]);

export const SaveOnboardingDraftInputSchema = z
  .object({
    role: DraftableRoleSchema.nullable(),
    currentStep: z.number().int().min(0).max(ONBOARDING_DRAFT_MAX_STEP),
    payload: OnboardingDraftPayloadSchema,
  })
  .strict();

export type SaveOnboardingDraftInput = {
  /** Static type stays the full UserRole enum because the wizard's local
   *  state may transiently hold any role value; the runtime schema narrows
   *  persistence to DraftableRoleSchema (the three public flows). */
  role: UserRole | null;
  currentStep: number;
  payload: Record<string, unknown>;
};

export type DraftActionResult =
  | { success: true }
  | { success: false; error: string };

export type LoadDraftActionResult =
  | { success: true; draft: OnboardingDraftSnapshot | null }
  | { success: false; error: string };

/** Values that must never reach the JSON column, recognized structurally so
 *  the check also works across realm boundaries (e.g. jsdom vs node). Dates
 *  are NOT listed here — they are converted, not dropped. */
function isNonSerializable(value: unknown): boolean {
  return (
    typeof value === "function" ||
    typeof value === "symbol" ||
    value === undefined ||
    (typeof value === "object" &&
      value !== null &&
      ((value.constructor && value.constructor.name === "File") ||
        (value.constructor && value.constructor.name === "Blob") ||
        value instanceof Promise))
  );
}

/**
 * Recursively convert wizard state into JSON-safe data:
 *   File/Blob/function/symbol/undefined/Promise → dropped
 *   Date → ISO string
 *   everything else passes through untouched
 * Depth- and entry-bounded so even a hostile payload terminates quickly; the
 * byte-size check after serialization is the real gate, this just keeps the
 * walk cheap.
 */
export function sanitizeDraftValue(
  value: unknown,
  depth = 0,
): Record<string, unknown> | unknown[] | string | number | boolean | null {
  if (value === null || typeof value !== "object") {
    if (isNonSerializable(value)) return null;
    return value as string | number | boolean | null;
  }

  if (depth >= 8) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, 200)
      .map((item) => sanitizeDraftValue(item, depth + 1));
  }

  if (isNonSerializable(value)) return null;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // The payload schema strips poisoned keys at the TOP level; this drops
    // them at every depth. `out["__proto__"] = {…}` is not an ordinary
    // property write — it invokes Object.prototype's setter and re-parents
    // the object being built, so the key has to be refused, not overwritten.
    if (POISONED_KEYS.has(key)) continue;
    const sanitized = sanitizeDraftValue(item, depth + 1);
    if (sanitized !== null || item === null) {
      out[key] = sanitized;
    }
  }
  return out;
}

/**
 * Single source of truth for turning wizard state into persistable draft
 * input: sanitize → re-package → byte-gate. Both the client encoder and the
 * server action persist EXACTLY what this returns, so neither path can drift
 * into writing unsanitized payloads.
 *
 * Returns null when validation fails or the serialized form exceeds budget.
 * Callers that need to TELL THOSE APART (to report a stuck draft rather than
 * skipping in silence) should use `prepareDraftForPersistDetailed`.
 */
export function prepareDraftForPersist(
  input: unknown,
): SaveOnboardingDraftInput | null {
  const result = prepareDraftForPersistDetailed(input);
  return result.ok ? result.value : null;
}

/** Why a draft snapshot could not be persisted. */
export type DraftRejectionReason =
  /** Failed the wire schema — includes a role outside the three public flows. */
  | "INVALID"
  /** Sanitized fine, but the serialized form exceeds ONBOARDING_DRAFT_MAX_BYTES. */
  | "OVER_BUDGET";

export type PrepareDraftResult =
  | { ok: true; value: SaveOnboardingDraftInput }
  | {
      ok: false;
      reason: DraftRejectionReason;
      bytes?: number;
      /** OVER_BUDGET only: the payload key that dominates the serialized form.
       *  "Your progress is too big" is unactionable on its own — the user
       *  cannot see the blob, so the warning has to name the field to trim. */
      largestField?: string;
    };

/** The single biggest top-level contributor to the serialized payload. Only
 *  ever called on the rejection path, so the second serialization pass costs
 *  nothing in the common case. */
function largestPayloadField(
  payload: Record<string, unknown>,
): string | undefined {
  const encoder = new TextEncoder();
  let winner: string | undefined;
  let winnerBytes = 0;
  for (const [key, value] of Object.entries(payload)) {
    if (key === ONBOARDING_DRAFT_VERSION_KEY) continue;
    const bytes = encoder.encode(JSON.stringify(value) ?? "").length;
    if (bytes > winnerBytes) {
      winnerBytes = bytes;
      winner = key;
    }
  }
  return winner;
}

/**
 * The reason-carrying form. A silent `null` conflates "this payload is
 * malformed" with "this user has simply written too much", and only the
 * second one means an otherwise-healthy wizard has stopped saving — so the
 * caller needs to know which it got.
 */
export function prepareDraftForPersistDetailed(
  input: unknown,
): PrepareDraftResult {
  const parsed = SaveOnboardingDraftInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID" };

  const sanitizedPayload = sanitizeDraftValue(parsed.data.payload) as Record<
    string,
    unknown
  >;
  const prepared: SaveOnboardingDraftInput = {
    ...parsed.data,
    // Stamped after sanitization so the marker is written by this function
    // alone: a caller cannot forge it, and the schema strips any inbound one.
    payload: {
      ...sanitizedPayload,
      [ONBOARDING_DRAFT_VERSION_KEY]: ONBOARDING_DRAFT_PAYLOAD_VERSION,
    },
  };

  const serialized = JSON.stringify(prepared);
  // Web-standard byte sizing: Buffer is a Node global present in client
  // bundles only via Next.js's incidental polyfill; TextEncoder is baseline
  // across runtimes and returns identical UTF-8 byte counts.
  const bytes = new TextEncoder().encode(serialized).length;
  if (bytes > ONBOARDING_DRAFT_MAX_BYTES) {
    return {
      ok: false,
      reason: "OVER_BUDGET",
      bytes,
      largestField: largestPayloadField(sanitizedPayload),
    };
  }
  return { ok: true, value: prepared };
}

/**
 * Restore Date-typed wizard fields from a JSON round-trip. Unknown or invalid
 * date fields are silently omitted — the step forms re-collect them, and a
 * hostile stored payload must never throw inside hydration.
 */
export function reviveDraftPayload(
  payload: unknown,
): Partial<Record<string, unknown>> {
  if (typeof payload !== "object" || payload === null) return {};
  const revived = DraftDateFieldsSchema.safeParse(payload);
  if (!revived.success) return { ...(payload as Record<string, unknown>) };
  return { ...(payload as Record<string, unknown>), ...revived.data };
}

/** Why a stored payload was thrown away instead of restored. */
export type DraftQuarantineReason =
  /** Written by a different wizard generation (or before the marker existed):
   *  the keys may mean something else now, so merging them is a guess. */
  | "VERSION"
  /** Survived the version check but not the shape contract — only reachable
   *  by editing the row out of band, since the writer parses the same schema. */
  | "SHAPE";

export interface StoredDraftPayloadResult {
  /** Always safe to spread into wizard state; empty when quarantined. */
  payload: Record<string, unknown>;
  /** Set when the stored payload was discarded rather than restored. */
  reason: DraftQuarantineReason | null;
}

/**
 * The read counterpart of `prepareDraftForPersistDetailed`: version-check,
 * re-assert the shape contract, revive dates.
 *
 * A version mismatch must NOT be spread. The failure mode it prevents is
 * quiet and expensive: a payload from an older wizard carries keys the
 * current forms read differently, so the user resumes onto a form that looks
 * filled but is subtly wrong, and only discovers it at submit-time validation
 * — or worse, not at all. Discarding costs re-typing one run; merging costs
 * trust in every answer on the screen. So the payload is dropped and the
 * caller is told, so the UI can say the form changed instead of silently
 * showing an empty wizard under a "we saved your progress" banner.
 *
 * The row itself is left alone: the wizard's next autosave overwrites it with
 * a correctly-stamped payload, which is one fewer write on the read path.
 */
export function readStoredDraftPayload(
  stored: unknown,
): StoredDraftPayloadResult {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return { payload: {}, reason: null };
  }
  const raw = stored as Record<string, unknown>;
  if (Object.keys(raw).length === 0) return { payload: {}, reason: null };

  if (raw[ONBOARDING_DRAFT_VERSION_KEY] !== ONBOARDING_DRAFT_PAYLOAD_VERSION) {
    return { payload: {}, reason: "VERSION" };
  }

  const shaped = OnboardingDraftPayloadSchema.safeParse(raw);
  if (!shaped.success) return { payload: {}, reason: "SHAPE" };

  return { payload: reviveDraftPayload(shaped.data), reason: null };
}

/**
 * Client-side convenience: validate + sanitize a draft snapshot exactly the
 * way the server action will, so callers can skip no-op saves and surface
 * size problems before the request. Returns null when validation fails.
 */
export function encodeDraftForSave(
  input: SaveOnboardingDraftInput,
): SaveOnboardingDraftInput | null {
  return prepareDraftForPersist(input);
}

/** `encodeDraftForSave` with the rejection reason kept. */
export function encodeDraftForSaveDetailed(
  input: SaveOnboardingDraftInput,
): PrepareDraftResult {
  return prepareDraftForPersistDetailed(input);
}

/**
 * Serializes draft-save promises so a later wizard state can never be
 * overwritten by an earlier in-flight upsert (true last-write-wins), and so
 * lifecycle code can DRAIN every dispatched-but-unsettled save before the
 * draft row is deleted — an upsert landing after the delete would resurrect
 * stale state (review round 1, page.tsx).
 */
export interface DraftSaveQueue {
  /** Chains task after all previously enqueued tasks; rejects if task throws.
   *  A previous failure never blocks a later task from running. */
  enqueue<T>(task: () => Promise<T>): Promise<T>;
  /** Resolves once every enqueued task has settled (fulfilled or rejected). */
  drain(): Promise<void>;
}

export function createDraftSaveQueue(): DraftSaveQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue(task) {
      const run = tail.then(task, task);
      // Keep the internal chain alive regardless of this task's outcome;
      // `run` itself surfaces rejection to the caller to handle.
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    drain() {
      return tail.then(
        () => undefined,
        () => undefined,
      );
    },
  };
}

// Re-exported for actions that need the DOB schema's guarantees on the way
// back out of a draft; kept here so importers have one draft-module import.
export { DateOfBirthSchema };
