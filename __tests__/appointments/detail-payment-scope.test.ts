/**
 * A webinar's attendees each carry a Payment on the same appointment. The
 * host reads a status per seat; an attendee must receive only their own
 * rows. Pins the scoping and the per-seat ranking the roster relies on.
 */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import {
  scopeAppointmentDetail,
  type TAppointmentDetail,
} from "@/lib/data/appointment-detail";
import {
  seatPaymentsByUser,
  summarizeSeatPayments,
} from "@/lib/appointments/seat-payments";

const HOST = "u-host";
const A = "u-a";
const B = "u-b";

const detail = {
  appointment: {
    id: "appt",
    organizationId: null,
    webinarId: "web-1",
    classId: null,
    webinar: { webinarPlan: { consultantProfile: { userId: HOST } } },
    slotsOfAppointment: [
      {
        user: [
          { id: A, name: "A", image: null },
          { id: B, name: "B", image: null },
        ],
      },
    ],
    payment: [
      {
        id: "p-a",
        userId: A,
        paymentStatus: "SUCCEEDED",
        amount: "324270",
        currency: "INR",
        createdAt: "2026-09-12T00:00:00Z",
        expiresAt: null,
      },
      {
        id: "p-b",
        userId: B,
        paymentStatus: "EXPIRED",
        amount: "274805",
        currency: "INR",
        createdAt: "2026-09-10T00:00:00Z",
        expiresAt: null,
      },
    ],
  },
  siblings: [],
} as unknown as TAppointmentDetail;

describe("scopeAppointmentDetail", () => {
  it("gives an attendee only their own payment rows", () => {
    const scoped = scopeAppointmentDetail(detail, A);
    expect(scoped.appointment.payment.map((p) => p.id)).toEqual(["p-a"]);
  });

  it("leaves a 1:1 booking whole for its attendee, whoever paid", () => {
    // A sponsored consultation: the Payment's userId is the org admin's, and
    // the attending consultee must still see the booking's payment.
    const consultation = {
      appointment: {
        id: "appt-1to1",
        organizationId: "org-1",
        webinarId: null,
        classId: null,
        consultation: {
          consultationPlan: { consultantProfile: { userId: HOST } },
          requestedBy: { userId: A },
        },
        slotsOfAppointment: [],
        payment: [
          {
            id: "p-sponsor",
            userId: "u-org-admin",
            paymentStatus: "SUCCEEDED",
            amount: "840865",
            currency: "INR",
            createdAt: "2026-09-12T00:00:00Z",
            expiresAt: null,
          },
        ],
      },
      siblings: [],
    } as unknown as TAppointmentDetail;
    expect(
      scopeAppointmentDetail(consultation, A).appointment.payment,
    ).toHaveLength(1);
  });

  it("leaves the host's and staff's view whole", () => {
    expect(
      scopeAppointmentDetail(detail, HOST).appointment.payment,
    ).toHaveLength(2);
    expect(
      scopeAppointmentDetail(detail, "u-staff", true).appointment.payment,
    ).toHaveLength(2);
  });
});

describe("seat payments", () => {
  it("lets a paid row speak for a seat over a lapsed one, then the newest", () => {
    const byUser = seatPaymentsByUser([
      {
        userId: A,
        paymentStatus: "EXPIRED",
        amount: 1,
        currency: "INR",
        createdAt: "2026-09-12T00:00:00Z",
      },
      {
        userId: A,
        paymentStatus: "SUCCEEDED",
        amount: 2,
        currency: "INR",
        createdAt: "2026-09-01T00:00:00Z",
      },
      {
        userId: B,
        paymentStatus: "PENDING",
        amount: 3,
        currency: "INR",
        createdAt: "2026-09-01T00:00:00Z",
      },
      {
        userId: B,
        paymentStatus: "PENDING",
        amount: 4,
        currency: "INR",
        createdAt: "2026-09-02T00:00:00Z",
      },
    ]);
    expect(Number(byUser.get(A)?.amount)).toBe(2);
    expect(Number(byUser.get(B)?.amount)).toBe(4);
    expect(summarizeSeatPayments(byUser)).toEqual({
      paid: 1,
      pending: 1,
      lapsed: 0,
      collectedPaise: 2,
      currency: "INR",
    });
  });

  it("names the currency from the first seat and counts a zero-amount seat as paid", () => {
    const byUser = seatPaymentsByUser([
      {
        userId: A,
        paymentStatus: "SUCCEEDED",
        amount: 0,
        currency: "INR",
        createdAt: "2026-09-01T00:00:00Z",
      },
      {
        userId: B,
        paymentStatus: "SUCCEEDED",
        amount: 500,
        currency: "USD",
        createdAt: "2026-09-01T00:00:00Z",
      },
    ]);
    expect(summarizeSeatPayments(byUser)).toEqual({
      paid: 2,
      pending: 0,
      lapsed: 0,
      collectedPaise: 500,
      currency: "INR",
    });
  });
});
