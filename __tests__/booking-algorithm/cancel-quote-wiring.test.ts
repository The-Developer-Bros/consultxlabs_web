/**
 * The cancellation quote has to reach the consultee, and it has to give up.
 *
 * R13 — `CancelConfirmationDialog` only fetches the quote when it is handed an
 * `appointmentId`. The consultant adapter passed one from the start; the
 * consultee adapter never did, so `previewEnabled` was false for the exact side
 * of the booking whose money the quote describes, and every learner saw the
 * generic policy sentence instead of their number.
 *
 * R18 — the fetch had no deadline, and the confirm button is disabled while it
 * loads. A hung preview therefore locked someone out of cancelling their own
 * booking behind a spinner that never stopped.
 *
 * Source contracts rather than a render: this repo has no React test renderer,
 * and both defects are wiring — a missing prop and a missing option — which the
 * source states directly.
 */

import fs from "fs";
import path from "path";

const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const consulteeAdapter = read(
  "components/appointments/consultee/ConsulteeAppointmentsAdapter.tsx",
);
const consultantAdapter = read(
  "app/dashboard/consultant/[consultantId]/(features)/appointments/ConsultantAppointmentsAdapter.tsx",
);
const dialog = read(
  "components/appointments/consultee/CancelConfirmationDialog.tsx",
);

/** The props block of the one `<CancelConfirmationDialog …>` in a file. */
function cancelDialogProps(source: string): string {
  const start = source.indexOf("<CancelConfirmationDialog");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("/>", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("R13 — the consultee adapter forwards appointmentId to the quote", () => {
  it("passes activeVm.appointmentId, so previewEnabled can be true", () => {
    expect(cancelDialogProps(consulteeAdapter)).toContain(
      "appointmentId={activeVm.appointmentId}",
    );
  });

  it("matches the consultant adapter, which never had the gap", () => {
    expect(cancelDialogProps(consultantAdapter)).toContain(
      "appointmentId={activeVm.appointmentId}",
    );
  });

  it("still gates the fetch on the id being present", () => {
    // The prop is optional by design — callers that cannot name the row keep
    // the policy sentence rather than fetching a quote for `undefined`.
    expect(dialog).toContain("isOpen && !!appointmentId");
  });
});

describe("R18 — the quote gives up rather than spinning forever", () => {
  it("bounds the preview fetch with an abort deadline", () => {
    expect(dialog).toContain("AbortSignal.timeout(8_000)");
  });

  it("says the quote failed but the policy still applies", () => {
    expect(dialog).toContain("isPreviewError");
    expect(dialog).toContain("couldn't load the refund estimate");
    expect(dialog).toContain("cancellation policy still applies");
  });

  it("does not retry, so the deadline is the whole budget", () => {
    expect(dialog).toContain("retry: false");
  });
});
