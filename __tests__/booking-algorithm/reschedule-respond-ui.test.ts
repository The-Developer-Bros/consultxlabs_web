/**
 * #1163 / #1169 PR 4b (UI half) — the respond endpoint has UI callers, and
 * withdraw has one. Source contracts: these assert the wiring that turns the
 * API loop shipped in PR 4a into something a consultee can actually click.
 */

import fs from "fs";
import path from "path";

const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const proposalCard = read(
  "components/appointments/detail/RescheduleProposalCard.tsx",
);
const detailClient = read(
  "components/appointments/detail/AppointmentDetailClient.tsx",
);
const adapter = read(
  "components/appointments/consultee/ConsulteeAppointmentsAdapter.tsx",
);
const eventActions = read(
  "components/appointments/consultee/useEventActions.ts",
);
const allocationTab = read(
  "components/dashboard/shared/requests/RequestSlotAllocationTab.tsx",
);
const reschedulePage = read(
  "app/dashboard/consultee/[consulteeId]/(features)/appointments/[appointmentId]/reschedule/page.tsx",
);

describe("#1163 — the proposal card answers through the lifecycle endpoints", () => {
  it("calls respond with an action and withdraw without one", () => {
    expect(proposalCard).toContain("/reschedule/respond");
    expect(proposalCard).toContain("/reschedule/withdraw");
    expect(proposalCard).toContain("JSON.stringify({ action: kind })");
  });

  it("splits the affordances by identity: counterparty answers, initiator withdraws", () => {
    expect(proposalCard).toContain("proposal.initiatedById");
    expect(proposalCard).toContain('mutation.mutate("withdraw")');
    expect(proposalCard).toContain('mutation.mutate("accept")');
    expect(proposalCard).toContain('mutation.mutate("decline")');
  });

  it("decline confirms first and says the booking is not being cancelled", () => {
    expect(proposalCard).toContain("not");
    expect(proposalCard).toContain("cancelling the booking");
    expect(proposalCard).toContain("AlertDialog");
  });

  it("invalidates the detail and events caches and relays the server message", () => {
    expect(proposalCard).toContain('["appointment-detail", appointmentId]');
    expect(proposalCard).toContain('["consultee-events"]');
    expect(proposalCard).toContain("description: data.message");
  });

  it("mounts on the shared detail page off the live rescheduleRequests read", () => {
    expect(detailClient).toContain("RescheduleProposalCard");
    expect(detailClient).toContain("rescheduleRequests?.[0]");
  });
});

describe("#1163 — the consultee list surfaces the proposal", () => {
  it("the adapter navigates to the appointment CARRYING the proposal", () => {
    expect(adapter).toContain("openProposalTarget");
    expect(adapter).toContain("groupAppointments");
    expect(adapter).toContain("proposalTarget.appointmentId");
  });
});

describe("#1163 — cancel/reschedule invalidation reaches the detail hub", () => {
  it("useEventActions always invalidates appointment-detail", () => {
    expect(eventActions).toContain('["appointment-detail", appointmentId]');
  });

  it("the adapter threads its resolved consulteeId instead of trusting useParams", () => {
    expect(eventActions).toContain("consulteeIdOverride");
    // The adapter passes the id it resolved (options → params → session).
    expect(adapter).toMatch(/useEventActions\(\{[\s\S]*?consulteeId,[\s\S]*?\}\)/);
  });
});

describe("#1163 — the consultant inbox answers proposals", () => {
  it("Use Requested Times routes an answerable proposal through respond-accept", () => {
    expect(allocationTab).toContain("answerableProposal");
    expect(allocationTab).toContain("/reschedule/respond");
    expect(allocationTab).toContain('action: "accept"');
    // The suppression is lifted BY the proposal, not removed outright.
    expect(allocationTab).toContain("rescheduledSlotCount");
  });

  it("only a PENDING_REVIEW consultee-initiated proposal with times is answerable", () => {
    expect(allocationTab).toContain('proposal.status !== "PENDING_REVIEW"');
    expect(allocationTab).toContain('proposal.initiatorRole !== "CONSULTEE"');
    expect(allocationTab).toContain("currentRoundSlots(proposal).length === 0");
  });

  it("decline is confirmed, covers subscriptions, and disables in flight", () => {
    expect(allocationTab).toContain("handleDeclineConfirm");
    expect(allocationTab).toContain("/api/bookings/subscriptions/");
    expect(allocationTab).toContain('JSON.stringify({ status: "REJECTED" })');
    expect(allocationTab).toContain("declining");
    expect(allocationTab).toContain("AlertDialog");
  });
});

describe("#1163 — the reschedule page refuses trial subjects", () => {
  it("renders a friendly refusal instead of a picker that 403s at submit", () => {
    expect(reschedulePage).toContain('appointmentType === "TRIAL"');
    expect(reschedulePage).toContain("can&apos;t be rescheduled");
  });
});
