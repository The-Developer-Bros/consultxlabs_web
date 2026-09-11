/**
 * Tests for calculateSessionProgress — consultant session count / progress.
 *
 * Regression: the zero-slot subscription checkout placeholder (preserved by the
 * allocation full-delete guard, commit 396ae8ac) must NOT be counted as a
 * session, otherwise a 10-session sub shows "11 remaining" on the consultant
 * Appointment/Home tabs.
 */

import { calculateSessionProgress } from "@/app/dashboard/consultant/[consultantId]/utils/appointmentHelpers";

// Minimal appointment shape — calculateSessionProgress only reads slotsOfAppointment[].startsAt.
function slottedAppt(startISO: string) {
  return { slotsOfAppointment: [{ startsAt: startISO }] } as any;
}
const placeholder = { slotsOfAppointment: [] } as any; // checkout placeholder: no slots

describe("calculateSessionProgress", () => {
  const ref = new Date("2025-06-01T00:00:00Z");

  it("excludes the zero-slot placeholder from totalSessions and remaining", () => {
    const group = [
      slottedAppt("2025-07-01T10:00:00Z"),
      slottedAppt("2025-07-08T10:00:00Z"),
      slottedAppt("2025-07-15T10:00:00Z"),
      placeholder, // must be ignored
    ];

    const r = calculateSessionProgress(group, ref);

    expect(r.totalSessions).toBe(3); // not 4
    expect(r.remainingSessions).toBe(3); // "3 remaining", not 4
    expect(r.completedSessions).toBe(0);
  });

  it("still splits completed (all-past) vs remaining correctly", () => {
    const group = [
      slottedAppt("2025-05-01T10:00:00Z"), // past → completed
      slottedAppt("2025-05-15T10:00:00Z"), // past → completed
      slottedAppt("2025-07-01T10:00:00Z"), // future → remaining
      placeholder, // excluded
    ];

    const r = calculateSessionProgress(group, ref);

    expect(r.totalSessions).toBe(3);
    expect(r.completedSessions).toBe(2);
    expect(r.remainingSessions).toBe(1);
    expect(r.progressPercentage).toBeCloseTo((2 / 3) * 100);
  });

  it("a group of only a placeholder yields zero sessions", () => {
    const r = calculateSessionProgress([placeholder], ref);
    expect(r.totalSessions).toBe(0);
    expect(r.remainingSessions).toBe(0);
    expect(r.progressPercentage).toBe(0);
  });
});
