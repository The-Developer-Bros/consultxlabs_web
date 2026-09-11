/**
 * @jest-environment node
 */

/**
 * #679 — webhook metadata validation across the slot-key rename.
 *
 * Razorpay order notes are persisted EXTERNAL data: orders created before
 * the startsAt/endsAt rename replay webhooks carrying the legacy
 * slotStartTimeInUTC/slotEndTimeInUTC keys. The dual-read must accept both
 * shapes until the transition window closes (normalizeLegacySlotKeys —
 * remove after 2026-07-12).
 */
import {
  normalizeLegacySlotKeys,
  validateWebhookMetadata,
} from "../../schemas/webhooks/metadata";

const BASE = {
  appointmentType: "CONSULTATION",
  userId: "cjld2cjxh0000qzrmn831i7rn", // cuid shape
  planId: "cjld2cyuq0000t3rmniod1foy",
};

const NEW_KEYS = {
  startsAt: "2026-06-12T10:00:00.000Z",
  endsAt: "2026-06-12T10:30:00.000Z",
};

describe("validateWebhookMetadata — slot-key rename dual-read", () => {
  it("accepts the NEW keys (post-rename orders)", () => {
    const parsed = validateWebhookMetadata({ ...BASE, ...NEW_KEYS });
    // Narrow the discriminated union — only the consultation branch
    // carries the slot keys.
    if (parsed.appointmentType !== "CONSULTATION") {
      throw new Error("expected consultation metadata");
    }
    expect(parsed.startsAt).toBe(NEW_KEYS.startsAt);
    expect(parsed.endsAt).toBe(NEW_KEYS.endsAt);
  });

  it("accepts the LEGACY keys (in-flight pre-rename orders)", () => {
    const parsed = validateWebhookMetadata({
      ...BASE,
      slotStartTimeInUTC: NEW_KEYS.startsAt,
      slotEndTimeInUTC: NEW_KEYS.endsAt,
    });
    if (parsed.appointmentType !== "CONSULTATION") {
      throw new Error("expected consultation metadata");
    }
    expect(parsed.startsAt).toBe(NEW_KEYS.startsAt);
    expect(parsed.endsAt).toBe(NEW_KEYS.endsAt);
  });

  it("prefers the new keys when both are present", () => {
    const normalized = normalizeLegacySlotKeys({
      startsAt: NEW_KEYS.startsAt,
      slotStartTimeInUTC: "1999-01-01T00:00:00.000Z",
    });
    expect(normalized.startsAt).toBe(NEW_KEYS.startsAt);
    expect(normalized.slotStartTimeInUTC).toBeUndefined();
  });

  it("still rejects a consultation with no slot keys at all", () => {
    expect(() => validateWebhookMetadata({ ...BASE })).toThrow();
  });
});

/**
 * #1462 — a scheduling-period subscription carries no direct slots, and the
 * builder used to send `startsAt`/`endsAt` to the gateway as empty strings.
 * `z.string().datetime().optional()` admits an ABSENT key and rejects `""`, so
 * every capture for such a sale failed validation and was stamped
 * REQUIRES_MANUAL_RECOVERY with the money already taken. The builder no longer
 * emits those keys, but Razorpay orders never expire, so orders already minted
 * with empty strings keep replaying and the validator has to absorb them.
 */
describe("validateWebhookMetadata — empty-string notes are absent fields", () => {
  const SUBSCRIPTION_BASE = {
    ...BASE,
    appointmentType: "SUBSCRIPTION",
    schedulingPeriodStartsAt: "2026-09-01T00:00:00.000Z",
    schedulingPeriodEndsAt: "2026-12-01T00:00:00.000Z",
  };

  it("validates an in-flight scheduling-period order carrying startsAt/endsAt as empty strings", () => {
    const parsed = validateWebhookMetadata({
      ...SUBSCRIPTION_BASE,
      startsAt: "",
      endsAt: "",
      slotOfAvailabilityWeeklyId: "",
      notes: "",
    });

    if (parsed.appointmentType !== "SUBSCRIPTION") {
      throw new Error("expected subscription metadata");
    }
    expect(parsed.startsAt).toBeUndefined();
    expect(parsed.endsAt).toBeUndefined();
    expect(parsed.notes).toBeUndefined();
    expect(parsed.schedulingPeriodStartsAt).toBe(
      SUBSCRIPTION_BASE.schedulingPeriodStartsAt,
    );
  });

  it("does not let an empty legacy key shadow a real slot time", () => {
    const parsed = validateWebhookMetadata({
      ...BASE,
      slotStartTimeInUTC: NEW_KEYS.startsAt,
      slotEndTimeInUTC: NEW_KEYS.endsAt,
      startsAt: "",
      endsAt: "",
    });

    if (parsed.appointmentType !== "CONSULTATION") {
      throw new Error("expected consultation metadata");
    }
    expect(parsed.startsAt).toBe(NEW_KEYS.startsAt);
    expect(parsed.endsAt).toBe(NEW_KEYS.endsAt);
  });
});
