/**
 * @jest-environment node
 */

/**
 * #1134 P1-7 — recording consent.
 *
 * The property that matters is that a refusal has an EFFECT. Before this, the
 * consultee's only signal was a `REC hh:mm` pill that appeared after recording
 * had started; there was no notice, no refusal, and no record. A prompt that
 * cannot change the outcome is worse than none, because it launders the
 * absence of choice.
 *
 * The split is the other half: a 1:1 decline must block, and a group decline
 * must not — the recording is the product there, one attendee cannot veto the
 * replay 199 others paid for, and pretending otherwise would be a promise the
 * system does not keep.
 */

import { RecordingConsentDecision } from "@prisma/client";

// The factory is hoisted above every const in this file, so it has to build the
// jest.fn()s itself; a captured local would still be in its temporal dead zone
// when the module under test first requires prisma. The handles come back off
// the mocked module below.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meetingRecordingConsent: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      count: jest.fn(),
    },
  },
}));

import prisma from "../../lib/prisma";

const mockConsent = prisma.meetingRecordingConsent as unknown as {
  findUnique: jest.Mock;
  upsert: jest.Mock;
  count: jest.Mock;
};

import {
  consentRegimeFor,
  getRecordingBlock,
  getRecordingNotice,
  recordRecordingConsent,
  RECORDING_NOTICE_VERSION,
} from "../../lib/stream/recording-consent";

const plan = (recordingEnabled: boolean) => ({
  consultantProfileId: "c1",
  recordingEnabled,
});

const CONSULTATION = { consultation: { consultationPlan: plan(true) } };
const SUBSCRIPTION = { subscription: { subscriptionPlan: plan(true) } };
const WEBINAR = { webinar: { webinarPlan: plan(true) } };
const CLASS = { class: { classPlan: plan(true) } };

beforeEach(() => jest.clearAllMocks());

describe("consent regime", () => {
  it("treats 1:1 as a real opt-out", () => {
    expect(consentRegimeFor(CONSULTATION)).toBe("OPT_OUT");
    expect(consentRegimeFor(SUBSCRIPTION)).toBe("OPT_OUT");
    // A trial carries neither relation and must not fall into the group regime.
    expect(consentRegimeFor({})).toBe("OPT_OUT");
    expect(consentRegimeFor(null)).toBe("OPT_OUT");
  });

  it("treats group sessions as acknowledge-only", () => {
    expect(consentRegimeFor(WEBINAR)).toBe("ACKNOWLEDGE");
    expect(consentRegimeFor(CLASS)).toBe("ACKNOWLEDGE");
  });
});

describe("the notice", () => {
  it("is not required when the plan has recording off", async () => {
    const notice = await getRecordingNotice("s1", "u1", {
      consultation: { consultationPlan: plan(false) },
    });
    expect(notice.required).toBe(false);
    // No lookup at all — the prompt must stay off the overwhelming majority of
    // sessions rather than querying for every lobby load.
    expect(mockConsent.findUnique).not.toHaveBeenCalled();
  });

  it("returns the standing decision when one exists", async () => {
    mockConsent.findUnique.mockResolvedValue({
      decision: RecordingConsentDecision.DECLINED,
    });
    const notice = await getRecordingNotice("s1", "u1", CONSULTATION);
    expect(notice).toMatchObject({
      required: true,
      regime: "OPT_OUT",
      decision: RecordingConsentDecision.DECLINED,
      noticeVersion: RECORDING_NOTICE_VERSION,
    });
  });

  it("reports no decision for someone who has not answered", async () => {
    mockConsent.findUnique.mockResolvedValue(null);
    expect((await getRecordingNotice("s1", "u1", WEBINAR)).decision).toBeNull();
  });
});

describe("recording the decision", () => {
  it("is idempotent per (session, user) and stamps the notice version", async () => {
    mockConsent.upsert.mockResolvedValue({});
    await recordRecordingConsent("s1", "u1", RecordingConsentDecision.GRANTED);

    const arg = mockConsent.upsert.mock.calls[0][0];
    // Changing your mind must update the standing row, never stack a second
    // one — otherwise "has anyone declined" depends on row ordering.
    expect(arg.where).toEqual({
      meetingSessionId_userId: { meetingSessionId: "s1", userId: "u1" },
    });
    expect(arg.create.noticeVersion).toBe(RECORDING_NOTICE_VERSION);
    expect(arg.update.noticeVersion).toBe(RECORDING_NOTICE_VERSION);
    expect(arg.update.decision).toBe(RecordingConsentDecision.GRANTED);
  });
});

describe("the recording gate", () => {
  it("blocks a 1:1 when anyone declined", async () => {
    mockConsent.count.mockResolvedValue(1);
    const block = await getRecordingBlock("s1", CONSULTATION);
    expect(block.blocked).toBe(true);
    expect(block.reason).toBeTruthy();
  });

  it("never names who declined", async () => {
    mockConsent.count.mockResolvedValue(1);
    const { reason } = await getRecordingBlock("s1", CONSULTATION);
    // Telling the consultant WHICH participant refused makes refusing socially
    // costly, which is the same as not offering the choice.
    expect(reason).not.toMatch(/u1|user|participant-\w+/i);
    expect(reason).toMatch(/a participant declined/i);
  });

  it("allows a 1:1 when nobody declined", async () => {
    mockConsent.count.mockResolvedValue(0);
    expect((await getRecordingBlock("s1", SUBSCRIPTION)).blocked).toBe(false);
  });

  it("never blocks a group session, even with a DECLINED row", async () => {
    // Defence in depth: the API refuses to write DECLINED for a group session,
    // but a legacy or hand-written row must not be able to kill a webinar
    // replay that every other attendee paid for.
    mockConsent.count.mockResolvedValue(5);
    expect((await getRecordingBlock("s1", WEBINAR)).blocked).toBe(false);
    expect((await getRecordingBlock("s1", CLASS)).blocked).toBe(false);
    expect(mockConsent.count).not.toHaveBeenCalled();
  });
});
