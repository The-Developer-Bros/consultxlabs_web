/**
 * @jest-environment node
 */

/**
 * #1067 — the in-call pill read "● 2:41:12   1 hr 19 min left": two durations
 * side by side, only one of them labelled. Nothing said whether 2:41:12 was
 * elapsed or remaining, and because both were on screen the natural reading
 * was that they contradicted each other. They never did — the first was
 * elapsed, the second what was left of a four-hour booking.
 *
 * The fix is hierarchy and words, not arithmetic: what remains leads, because
 * that is what a consultant acts on, and anything that stays is labelled.
 */

// The module also carries React hooks that reach the Stream SDK and the auth
// client; `readClock` itself is pure. Stubbed so the wording can be asserted
// without dragging an ESM-only auth bundle through the transformer.
jest.mock("@stream-io/video-react-sdk", () => ({
  useCallStateHooks: () => ({}),
}));
jest.mock("../../lib/auth-client", () => ({ useSession: () => ({}) }));

import { readClock } from "../../app/meetings/[id]/session-info";

/** The reported session: a four-hour booking starting at 12:30. */
const START = new Date("2026-08-01T12:30:00.000Z");
const END = new Date("2026-08-01T16:30:00.000Z");

const at = (iso: string) => readClock(START, END, new Date(iso));

describe("the in-call clock says which duration is which", () => {
  it("leads with what is left, and labels the elapsed clock", () => {
    // The exact moment from the report: 2h 41m in, 1h 19m to go.
    const clock = at("2026-08-01T15:11:12.000Z");

    expect(clock.phase).toBe("in-progress");
    expect(clock.status).toBe("1 hr 19 min left");
    expect(clock.elapsed).toBe("2:41:12");
    expect(clock.elapsedLabel).toBe("2:41:12 elapsed");
    // The defect in one assertion: nothing the pill renders is a bare number.
    expect(clock.elapsedLabel).toContain("elapsed");
  });

  it("counts down in readable units near the end", () => {
    const clock = at("2026-08-01T16:26:00.000Z");

    expect(clock.phase).toBe("in-progress");
    expect(clock.status).toBe("4 min left");
    expect(clock.elapsedLabel).toBe("3:56:00 elapsed");
  });

  it("switches to overrun instead of counting into negatives", () => {
    // Nothing ends the call for us — `max_duration_seconds` is deliberately
    // not sent (#1070) — so a session does run past its booked end. "1 hr 19
    // min left" going negative would be worse than the ambiguity it replaced.
    const clock = at("2026-08-01T16:50:00.000Z");

    expect(clock.phase).toBe("overrunning");
    expect(clock.status).toBe("20 min over");
    expect(clock.remaining).toBeNull();
    expect(clock.status).not.toMatch(/-|left/);
    // Elapsed keeps running, still labelled.
    expect(clock.elapsedLabel).toBe("4:20:00 elapsed");
  });

  it("says 'over' the moment the booked end passes", () => {
    expect(at("2026-08-01T16:30:00.000Z").phase).toBe("overrunning");
    expect(at("2026-08-01T16:29:59.000Z").phase).toBe("in-progress");
  });

  it("still has something to lead with when there is no booked end", () => {
    const clock = readClock(START, null, new Date("2026-08-01T13:30:00.000Z"));

    expect(clock.status).toBe("In progress");
    expect(clock.remaining).toBeNull();
    expect(clock.elapsedLabel).toBe("1:00:00 elapsed");
  });

  it("has no elapsed clock before the session starts", () => {
    const clock = at("2026-08-01T12:24:00.000Z");

    expect(clock.phase).toBe("starting-soon");
    expect(clock.status).toBe("Starts in 6 min");
    expect(clock.elapsed).toBeNull();
    expect(clock.elapsedLabel).toBeNull();
  });
});
