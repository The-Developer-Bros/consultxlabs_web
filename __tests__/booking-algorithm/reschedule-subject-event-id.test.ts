/**
 * Reschedule heatmaps need the real event id so fetchEventSlots can paint
 * "This booking" / "Being moved". Omitting it left those cells looking like
 * foreign bookings.
 */

import type { TAppointmentDetail } from "@/lib/data/appointment-detail";
import { buildRescheduleSubject } from "@/lib/scheduling/slot-picker-subject";

const futureStart = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const futureEnd = new Date(futureStart.getTime() + 60 * 60 * 1000);

function consultationDetail(
  overrides: Partial<{
    consultationId: string;
    consultantProfileId: string;
  }> = {},
): TAppointmentDetail {
  const consultationId =
    overrides.consultationId ?? "329c0b89-0648-4f8e-82e4-25811cdea440";
  const consultantProfileId = overrides.consultantProfileId ?? "cp-uuid-1";
  return {
    appointment: {
      id: "appt-uuid-1",
      appointmentType: "CONSULTATION",
      slotsOfAppointment: [
        {
          id: "slot-1",
          startsAt: futureStart,
          endsAt: futureEnd,
          isTentative: false,
          completionStatus: "SCHEDULED",
          appointmentId: "appt-uuid-1",
          user: [],
          meetingSession: null,
        },
      ],
      consultation: {
        id: consultationId,
        requestedBy: {
          id: "consultee-1",
          userId: "user-consultee-1",
          user: { id: "user-consultee-1", name: "Buyer", image: null },
        },
        consultationPlan: {
          title: "Career chat",
          durationInHours: 2,
          consultantProfile: {
            id: consultantProfileId,
            userId: "user-consultant-1",
            user: { id: "user-consultant-1", name: "Expert", image: null },
          },
        },
      },
      subscription: null,
      webinar: null,
      class: null,
      trialSession: null,
    },
    siblings: [],
  } as unknown as TAppointmentDetail;
}

function subscriptionDetail(): TAppointmentDetail {
  return {
    appointment: {
      id: "appt-sub-1",
      appointmentType: "SUBSCRIPTION",
      slotsOfAppointment: [
        {
          id: "slot-s1",
          startsAt: futureStart,
          endsAt: futureEnd,
          isTentative: true,
          completionStatus: "SCHEDULED",
          appointmentId: "appt-sub-1",
          user: [],
          meetingSession: null,
        },
      ],
      consultation: null,
      subscription: {
        id: "clxxxxxxxxxxxxxxxxxxxxxxx",
        requestedBy: {
          id: "consultee-1",
          userId: "user-consultee-1",
          user: { id: "user-consultee-1", name: "Buyer", image: null },
        },
        subscriptionPlan: {
          title: "Weekly coaching",
          sessionDurationInHours: 1,
          consultantProfile: {
            id: "cp-uuid-1",
            userId: "user-consultant-1",
            user: { id: "user-consultant-1", name: "Expert", image: null },
          },
        },
      },
      webinar: null,
      class: null,
      trialSession: null,
    },
    siblings: [],
  } as unknown as TAppointmentDetail;
}

describe("buildRescheduleSubject event context", () => {
  it("passes consultation eventId + eventType for paint", () => {
    const subject = buildRescheduleSubject(consultationDetail());
    expect(subject).not.toBeNull();
    expect(subject!.subject.eventType).toBe("consultation");
    expect(subject!.subject.eventId).toBe(
      "329c0b89-0648-4f8e-82e4-25811cdea440",
    );
    expect(subject!.subject.durationInHours).toBe(2);
  });

  it("passes subscription eventId + eventType and hasReleasedSlots when tentative", () => {
    const subject = buildRescheduleSubject(subscriptionDetail());
    expect(subject).not.toBeNull();
    expect(subject!.subject.eventType).toBe("subscription");
    expect(subject!.subject.eventId).toBe("clxxxxxxxxxxxxxxxxxxxxxxx");
    expect(subject!.subject.hasReleasedSlots).toBe(true);
  });

  it("returns null when there is no consultant to draw a grid for", () => {
    const detail = consultationDetail({ consultantProfileId: "" });
    // Empty consultant id → falsy → null
    (detail.appointment.consultation!.consultationPlan!.consultantProfile as {
      id: string;
    }).id = "";
    expect(buildRescheduleSubject(detail)).toBeNull();
  });
});
