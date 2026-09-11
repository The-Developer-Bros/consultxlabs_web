/**
 * @jest-environment node
 */

/**
 * #1134 P1-6 — recording a 1:1 was not disabled, it was IMPOSSIBLE.
 *
 * `isAppointmentOwner` and `isRecordingEnabledForAppointment` each hand-rolled
 * an if/else over `webinar` and `class` only. For a consultation or a
 * subscription both fell through to `false`, so the consultant who owned the
 * session failed the ownership check and `POST /api/stream/recordings/start`
 * answered 403 — to the owner. `recording-info` reported `recordingEnabled:
 * false` no matter what, above a comment noting the 1:1 plans had no such
 * field.
 *
 * Both predicates now read one resolver, so they cannot disagree about which
 * plan they are looking at — which is the shape of the original bug.
 */

import {
  isAppointmentOwner,
  isRecordingEnabledForAppointment,
  resolveAppointmentPlan,
  type AppointmentWithOwnership,
  type OwnedPlan,
} from "@/lib/stream/recording-utils";

const OWNER = "consultant-profile-1";
const OTHER = "consultant-profile-2";

const withPlan = (kind: string, plan: OwnedPlan): AppointmentWithOwnership => {
  switch (kind) {
    case "webinar":
      return { webinar: { webinarPlan: plan } };
    case "class":
      return { class: { classPlan: plan } };
    case "consultation":
      return { consultation: { consultationPlan: plan } };
    default:
      return { subscription: { subscriptionPlan: plan } };
  }
};

const KINDS = ["webinar", "class", "consultation", "subscription"] as const;

describe("recording capability covers every appointment kind", () => {
  it.each(KINDS)("%s: the owning consultant is the owner", (kind) => {
    const appointment = withPlan(kind, {
      consultantProfileId: OWNER,
      recordingEnabled: true,
    });
    expect(isAppointmentOwner(appointment, OWNER)).toBe(true);
    expect(isAppointmentOwner(appointment, OTHER)).toBe(false);
  });

  it.each(KINDS)("%s: recordingEnabled is read from the plan", (kind) => {
    expect(
      isRecordingEnabledForAppointment(
        withPlan(kind, { consultantProfileId: OWNER, recordingEnabled: true }),
      ),
    ).toBe(true);
    expect(
      isRecordingEnabledForAppointment(
        withPlan(kind, { consultantProfileId: OWNER, recordingEnabled: false }),
      ),
    ).toBe(false);
  });

  it("defaults closed when the plan omits the flag", () => {
    // A 1:1 is the most sensitive session type on the platform. An absent flag
    // must never read as consent to record.
    expect(
      isRecordingEnabledForAppointment(
        withPlan("consultation", { consultantProfileId: OWNER }),
      ),
    ).toBe(false);
  });

  it("never treats a missing consultantProfileId as ownership", () => {
    // Guards the null-vs-null trap: an appointment whose plan has no consultant
    // must not match a caller who also has none.
    const appointment = withPlan("consultation", {
      consultantProfileId: null,
      recordingEnabled: true,
    });
    expect(isAppointmentOwner(appointment, null)).toBe(false);
    expect(isAppointmentOwner(appointment, undefined)).toBe(false);
  });

  it("resolves nothing for an empty or absent appointment", () => {
    expect(resolveAppointmentPlan(null)).toBeNull();
    expect(resolveAppointmentPlan(undefined)).toBeNull();
    expect(resolveAppointmentPlan({})).toBeNull();
    expect(isAppointmentOwner(null, OWNER)).toBe(false);
    expect(isRecordingEnabledForAppointment(null)).toBe(false);
  });

  it("the two predicates always read the same plan", () => {
    // The original defect was divergence: ownership looked at one set of kinds
    // and the recording flag at another. Assert they agree on every kind.
    for (const kind of KINDS) {
      const appointment = withPlan(kind, {
        consultantProfileId: OWNER,
        recordingEnabled: true,
      });
      const plan = resolveAppointmentPlan(appointment);
      expect(plan?.consultantProfileId).toBe(OWNER);
      expect(isAppointmentOwner(appointment, OWNER)).toBe(true);
      expect(isRecordingEnabledForAppointment(appointment)).toBe(true);
    }
  });
});
