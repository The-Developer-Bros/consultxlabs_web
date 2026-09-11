/**
 * Proposed times are 30-minute atoms (ADR B1), enforced at the contract edge.
 *
 * This is not style. Auto-confirm hands the allocator `startsAt` alone and
 * manual mode reads each string as ONE 30-minute start, so `endsAt` is never
 * consulted — a 60-minute proposal books 30 minutes. The count check passes
 * (one proposed row per released slot), which is exactly what makes it
 * invisible: the consultee asks to move a 1-hour session and silently gets
 * half of one.
 */

import { RescheduleProposalSchema } from "@/schemas/appointments";

const at = (iso: string) => new Date(iso).toISOString();

describe("RescheduleProposalSchema", () => {
  it("accepts a 30-minute proposal", () => {
    const parsed = RescheduleProposalSchema.safeParse({
      proposedSlots: [
        { startsAt: at("2026-09-01T09:00:00Z"), endsAt: at("2026-09-01T09:30:00Z") },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts consecutive atoms — a 1-hour session is two rows, not one long one", () => {
    const parsed = RescheduleProposalSchema.safeParse({
      proposedSlots: [
        { startsAt: at("2026-09-01T09:00:00Z"), endsAt: at("2026-09-01T09:30:00Z") },
        { startsAt: at("2026-09-01T09:30:00Z"), endsAt: at("2026-09-01T10:00:00Z") },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a 60-minute row, which would book 30", () => {
    const parsed = RescheduleProposalSchema.safeParse({
      proposedSlots: [
        { startsAt: at("2026-09-01T09:00:00Z"), endsAt: at("2026-09-01T10:00:00Z") },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a row shorter than an atom", () => {
    const parsed = RescheduleProposalSchema.safeParse({
      proposedSlots: [
        { startsAt: at("2026-09-01T09:00:00Z"), endsAt: at("2026-09-01T09:15:00Z") },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("still rejects an end at or before its start", () => {
    for (const endsAt of ["2026-09-01T09:00:00Z", "2026-08-01T09:00:00Z"]) {
      const parsed = RescheduleProposalSchema.safeParse({
        proposedSlots: [{ startsAt: at("2026-09-01T09:00:00Z"), endsAt: at(endsAt) }],
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("keeps 'any time works' valid — no proposed times at all", () => {
    // Releasing without naming a time predates proposals and is still the whole
    // contract for group events.
    expect(RescheduleProposalSchema.safeParse({ slotIds: ["a"] }).success).toBe(
      true,
    );
  });
});
