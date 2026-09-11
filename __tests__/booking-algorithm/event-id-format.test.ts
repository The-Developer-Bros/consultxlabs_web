/**
 * Allocate/validate routes reject non-UUID/CUID event ids via eventIdSchema.
 * isEventIdFormat is the shared SSR/client gate so mock PKs fail closed
 * before the Zod 400 toast.
 */

import {
  EVENT_ID_INVALID_MESSAGE,
  eventIdSchema,
  isEventIdFormat,
} from "@/schemas/slotAllocation/validationSchemas";

describe("isEventIdFormat", () => {
  it("accepts a UUID", () => {
    expect(isEventIdFormat("329c0b89-0648-4f8e-82e4-25811cdea440")).toBe(true);
  });

  it("accepts a CUIDv1-shaped id", () => {
    // 'c' + 24 alphanumeric = 25 chars
    expect(isEventIdFormat("clxxxxxxxxxxxxxxxxxxxxxxx")).toBe(true);
  });

  it("accepts a CUIDv2-shaped id (24 chars)", () => {
    expect(isEventIdFormat("a1b2c3d4e5f6g7h8i9j0k1l2")).toBe(true);
  });

  it("rejects mock0801-appt-pending", () => {
    expect(isEventIdFormat("mock0801-appt-pending")).toBe(false);
  });

  it("rejects empty / nullish", () => {
    expect(isEventIdFormat("")).toBe(false);
    expect(isEventIdFormat(null)).toBe(false);
    expect(isEventIdFormat(undefined)).toBe(false);
  });

  it("rejects short human-readable fixture ids", () => {
    expect(isEventIdFormat("appt-1")).toBe(false);
    expect(isEventIdFormat("consultation-1")).toBe(false);
  });
});

describe("eventIdSchema", () => {
  it("parses a valid UUID", () => {
    expect(eventIdSchema.parse("329c0b89-0648-4f8e-82e4-25811cdea440")).toBe(
      "329c0b89-0648-4f8e-82e4-25811cdea440",
    );
  });

  it("surfaces the invalid-format message for mock ids", () => {
    const result = eventIdSchema.safeParse("mock0801-appt-pending");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(EVENT_ID_INVALID_MESSAGE);
    }
  });
});
