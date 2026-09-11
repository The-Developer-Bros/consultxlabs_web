/**
 * @jest-environment node
 */

/**
 * Booking-org-stamping fix coverage — #768 Comment 5.
 *
 * SUBSCRIPTION lazy allocation, CLASS pre-allocation, marketplace WEBINAR, and
 * CONSULTATION reschedule each used to create Appointment rows with
 * `organizationId = null` even when the booker was org-funded. The org tag is
 * resolved per event type inside `SlotAllocationService.fetchEventData`:
 *
 *   - CONSULTATION → existing Appointment.organizationId (preserved across the
 *     reschedule delete+recreate).
 *   - SUBSCRIPTION → the placeholder Appointment's org, falling back to its
 *     Payment.organizationId (org-tagged at checkout).
 *   - WEBINAR      → webinarPlan.organizationId (Appointment is SHARED across
 *     attendees from any org).
 *   - CLASS        → classPlan.organizationId (host wins; marketplace = null).
 *
 * These tests drive the REAL resolution by calling `fetchEventData` with a
 * mocked Prisma tx per event type and asserting the resolved organizationId —
 * not a re-implementation of the rule. Full DB integration lives in the E2E
 * guide.
 */
import { SlotAllocationService } from "@/utils/slotAllocation/SlotAllocationService";
import type { EventType } from "@/utils/slotAllocation/types";

// Minimal consultant profile so fetchEventData resolves past its
// "consultant profile not found" guard — the tests only assert organizationId.
const CONSULTANT = {
  user: { id: "consultant-1", timezone: null },
  scheduleType: "WEEKLY",
  slotsOfAvailabilityWeekly: [],
  slotsOfAvailabilityCustom: [],
};

// fetchEventData is private + static; it uses only its `tx` arg (no `this`), so
// it's callable detached. Returns the resolved organizationId for the event.
async function resolveOrg(
  model: string,
  eventType: EventType,
  event: unknown,
): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = SlotAllocationService as any;
  const tx = {
    [model]: { findUnique: jest.fn().mockResolvedValue(event) },
  };
  const result = await svc.fetchEventData(tx, eventType, "evt-1");
  return result?.organizationId ?? null;
}

describe("Appointment.organizationId stamping (#768 Comment 5)", () => {
  it("CONSULTATION inherits the existing Appointment org (reschedule-safe)", async () => {
    const base = {
      consultationPlan: { consultantProfile: CONSULTANT, durationInHours: 1 },
      requestedBy: { user: { id: "consultee-1" } },
    };
    await expect(
      resolveOrg("consultation", "consultation", {
        ...base,
        appointment: { organizationId: "wipro-org-id", slotsOfAppointment: [] },
      }),
    ).resolves.toBe("wipro-org-id");

    // PERSONAL booking → no org tag.
    await expect(
      resolveOrg("consultation", "consultation", {
        ...base,
        appointment: { organizationId: null, slotsOfAppointment: [] },
      }),
    ).resolves.toBeNull();
  });

  it("SUBSCRIPTION inherits the placeholder Appointment org", async () => {
    const event = {
      subscriptionPlan: { consultantProfile: CONSULTANT, totalSessions: 4 },
      requestedBy: { user: { id: "consultee-1" } },
      appointments: [
        {
          organizationId: "wipro-org-id",
          slotsOfAppointment: [],
          payment: { organizationId: null },
        },
      ],
    };
    await expect(resolveOrg("subscription", "subscription", event)).resolves.toBe(
      "wipro-org-id",
    );
  });

  it("SUBSCRIPTION falls back to the Payment org when the Appointment is untagged", async () => {
    // The exact #768 Comment 5 bug: org-funded booker, placeholder Appointment
    // missing the tag → must recover it from Payment.organizationId.
    const event = {
      subscriptionPlan: { consultantProfile: CONSULTANT, totalSessions: 4 },
      requestedBy: { user: { id: "consultee-1" } },
      appointments: [
        {
          organizationId: null,
          slotsOfAppointment: [],
          payment: { organizationId: "wipro-org-id" },
        },
      ],
    };
    await expect(resolveOrg("subscription", "subscription", event)).resolves.toBe(
      "wipro-org-id",
    );
  });

  it("SUBSCRIPTION stays null for a PERSONAL booking", async () => {
    const event = {
      subscriptionPlan: { consultantProfile: CONSULTANT, totalSessions: 4 },
      requestedBy: { user: { id: "consultee-1" } },
      appointments: [
        {
          organizationId: null,
          slotsOfAppointment: [],
          payment: { organizationId: null },
        },
      ],
    };
    await expect(
      resolveOrg("subscription", "subscription", event),
    ).resolves.toBeNull();
  });

  it("WEBINAR uses the webinarPlan host org (shared across attendees)", async () => {
    await expect(
      resolveOrg("webinar", "webinar", {
        webinarPlan: {
          consultantProfile: CONSULTANT,
          durationInHours: 1,
          organizationId: "tata-org-id",
        },
      }),
    ).resolves.toBe("tata-org-id");

    await expect(
      resolveOrg("webinar", "webinar", {
        webinarPlan: {
          consultantProfile: CONSULTANT,
          durationInHours: 1,
          organizationId: null,
        },
      }),
    ).resolves.toBeNull();
  });

  it("CLASS uses the classPlan host org (host wins; marketplace = null)", async () => {
    const base = {
      appointments: [],
    };
    await expect(
      resolveOrg("class", "class", {
        ...base,
        classPlan: {
          consultantProfile: CONSULTANT,
          classContents: [],
          totalSessions: 4,
          organizationId: "infosys-org-id",
        },
      }),
    ).resolves.toBe("infosys-org-id");

    await expect(
      resolveOrg("class", "class", {
        ...base,
        classPlan: {
          consultantProfile: CONSULTANT,
          classContents: [],
          totalSessions: 4,
          organizationId: null,
        },
      }),
    ).resolves.toBeNull();
  });

  it("returns null event data when the row is missing", async () => {
    await expect(
      resolveOrg("consultation", "consultation", null),
    ).resolves.toBeNull();
  });
});
