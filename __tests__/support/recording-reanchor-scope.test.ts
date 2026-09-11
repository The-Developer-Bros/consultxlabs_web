/**
 * @jest-environment node
 */

/**
 * The 48-hour re-anchor applies to the "still waiting" claim only.
 *
 * `RECORDING_ACCESS` has TWO resolved terminals:
 *   - `within`  — "less than 48 hours since the session", a client-side claim
 *                 about elapsed time, which the server distrusts and re-anchors
 *                 when the real window has expired.
 *   - `fixed`   — "yes, it plays now", on the playback branch. A genuine
 *                 resolution that asserts nothing about time.
 *
 * Gating the re-anchor on the CATEGORY alone caught both. Recordings only
 * exist after processing, so most playback conversations happen well past the
 * 48-hour mark — meaning a user who reported the problem was GONE had their
 * confirmation discarded, was told "our team will chase the processing", and
 * generated a false `recording_missing` ticket for ops.
 *
 * These pin the shape of the flow the guard depends on. The guard reads
 * `turn.messages[0].metadata.nodeId`, which `walkFlow` sets to the terminal's
 * own id (lib/support/flow-walk.ts).
 */

import { walkFlow } from "@/lib/support/flow-walk";
import { flowForCategory } from "@/lib/support/flows";
import type { SupportContext } from "@/lib/support/types";

const completedCtx = {
  stage: "COMPLETED",
  isProvider: false,
  isOrgContext: false,
  isOrgOperator: false,
  refundPctIfCancelledNow: 0,
} as unknown as SupportContext;

function recordingFlow() {
  const flow = flowForCategory(completedCtx, "RECORDING_ACCESS");
  if (!flow) throw new Error("RECORDING_ACCESS not offered on a completed session");
  return flow;
}

describe("recording-access resolved terminals", () => {
  it("marks `within` resolved and tags the message with its node id", () => {
    const r = walkFlow(recordingFlow(), "missing", { chosenOptionId: "within" }, completedCtx);
    expect(r.resolved).toBe(true);
    expect(r.escalate).toBe(false);
    // The re-anchor guard keys off exactly this.
    expect(
      (r.messages[0]?.metadata as { nodeId?: string } | undefined)?.nodeId,
    ).toBe("within");
  });

  it("marks `fixed` resolved with a DIFFERENT node id, so the guard cannot catch it", () => {
    const r = walkFlow(recordingFlow(), "play", { chosenOptionId: "fixed" }, completedCtx);
    expect(r.resolved).toBe(true);
    expect(r.escalate).toBe(false);
    const nodeId = (r.messages[0]?.metadata as { nodeId?: string } | undefined)?.nodeId;
    expect(nodeId).toBe("fixed");
    expect(nodeId).not.toBe("within");
  });

  it("keeps `beyond` as the escalating target the re-anchor redirects to", () => {
    // The guard looks `beyond` up BY NAME rather than taking "the first
    // escalating terminal in object order" — which only happened to be right
    // because `beyond` is declared before `broken`. Reordering the nodes would
    // otherwise have started filing recording_broken for a missing recording.
    const r = walkFlow(recordingFlow(), "missing", { chosenOptionId: "beyond" }, completedCtx);
    expect(r.escalate).toBe(true);
    expect(r.reason).toBe("recording_missing");
  });

  it("keeps `broken` on its own reason", () => {
    const r = walkFlow(recordingFlow(), "play", { chosenOptionId: "broken" }, completedCtx);
    expect(r.escalate).toBe(true);
    expect(r.reason).toBe("recording_broken");
  });
});
