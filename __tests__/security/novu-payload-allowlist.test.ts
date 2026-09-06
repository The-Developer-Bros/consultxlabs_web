/**
 * ADR 20 for the notification layer.
 *
 * The list-helper allowlists (`org-scope-payload-allowlist.test.ts`) pin what
 * an organization can READ through the scoped queries. Nothing pinned what it
 * can be SENT. That gap matters because `RecordingPayload.recordingUrl` puts a
 * live media URL in a notification body, and the only thing keeping it away
 * from an operator is that `notifyRecordingAvailable` is called with
 * `getEventAttendeeIds(...)` — a participant list — rather than a roster.
 *
 * That is exactly the shape ADR 20 was written about: "the accident happened to
 * be mostly right... but it held only because no one had yet added a field to a
 * select statement". A future change widening that recipient list to
 * `rosterForOrg(orgId, VISIBILITY_ROLES)` would leak the URL with no test
 * failing, so these assertions pin the two halves of the rule:
 *
 *   1. Content-bearing payloads are only ever sent to participant-derived
 *      recipient lists.
 *   2. The org-roster dispatchers carry no content field at all.
 *
 * Source-level assertions for the same reason the sibling suite gives: what
 * matters is which recipient list each trigger reaches for.
 */

import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const ORG_WORKFLOWS = "lib/novu/org-workflows.ts";
const WORKFLOWS = "lib/novu/workflows.ts";
const RECORDING_HANDLERS = "lib/stream/recording-handlers.ts";

/**
 * Fields ADR 20 names as session CONTENT. A payload carrying one of these may
 * only reach the two people who were in the session.
 */
const CONTENT_FIELDS = [
  "recordingUrl",
  "fileUrl",
  "storagePath",
  "requestNotes",
  "feedbackFromConsultee",
  "feedbackFromConsultant",
  "cancellationNotes",
  "transcript",
];

describe("ADR 20 — org-roster notifications carry no session content", () => {
  it("no org-roster payload type declares a content field", () => {
    const src = read(ORG_WORKFLOWS);
    // Everything in org-workflows.ts dispatches to rosterForOrg(), so no
    // payload defined or forwarded there may name a content field.
    for (const field of CONTENT_FIELDS) {
      expect(src).not.toContain(field);
    }
  });

  it("the roster resolver is the only recipient source in org-workflows", () => {
    const src = read(ORG_WORKFLOWS);
    // Guards against someone importing getEventAttendeeIds here and blurring
    // the two audiences into one file.
    expect(src).not.toContain("getEventAttendeeIds");
    expect(src).toContain("rosterForOrg");
  });

  it("recording notifications go to participants, never a roster", () => {
    const src = read(RECORDING_HANDLERS);

    // Asserting that `getEventAttendeeIds` merely APPEARS is too weak — it would
    // still pass if the notifier were handed a roster while the resolver sat
    // unused elsewhere in the file. So bind the two: take the identifier
    // actually passed as the recipient argument, and require THAT identifier to
    // be the one assigned from the attendee resolver.
    const call = /notifyRecordingAvailable\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(
      src,
    );
    expect(call).not.toBeNull();
    const recipientVar = call![1];

    const assignedFromResolver = new RegExp(
      `(?:const|let|var)\\s+${recipientVar}\\s*=\\s*await\\s+getEventAttendeeIds\\(`,
    );
    expect(src).toMatch(assignedFromResolver);

    // And the roster resolvers must not be reachable from this file at all, so
    // the recipient list cannot be rebuilt from one further down.
    expect(src).not.toContain("rosterForOrg");
    expect(src).not.toContain("VISIBILITY_ROLES");
    expect(src).not.toContain("OPERATOR_ROLES");
  });

  it("RecordingPayload is still the only content-bearing shared payload", () => {
    const src = read(WORKFLOWS);
    // If a second payload grows a content field, this fails and whoever added
    // it has to come and think about who receives it.
    const carriers = CONTENT_FIELDS.filter((f) => src.includes(f));
    expect(carriers).toEqual(["recordingUrl"]);
  });
});

describe("ADR 23 — dual-context payloads are attributable", () => {
  const SCOPED_PAYLOADS = [
    "AppointmentPayload",
    "PaymentSuccessPayload",
    "BookingRequestPayload",
    "RecordingPayload",
  ];

  it.each(SCOPED_PAYLOADS)("%s composes NotificationScope", (name) => {
    const src = read(WORKFLOWS);
    expect(src).toContain(`export type ${name} = NotificationScope & {`);
  });

  it("notificationScope keeps scope and organizationId consistent", async () => {
    const { notificationScope } = await import("@/lib/novu/workflows");

    expect(notificationScope(null)).toEqual({
      organizationId: null,
      scope: "personal",
    });
    expect(notificationScope(undefined)).toEqual({
      organizationId: null,
      scope: "personal",
    });
    expect(notificationScope("org_1", "Acme")).toEqual({
      organizationId: "org_1",
      scope: "org",
      orgName: "Acme",
    });
    // A personal notification must not carry an org name — it would render an
    // attribution the scope contradicts.
    expect(notificationScope(null, "Acme")).toEqual({
      organizationId: null,
      scope: "personal",
    });
  });
});

/**
 * #536 — the inbox showed customers a raw ISO timestamp, an integer count of
 * paise and a shouted enum, because the Novu templates interpolate payload
 * fields verbatim. One pin over the whole trigger boundary rather than a unit
 * test per formatter: what matters is the string that leaves the process, and
 * that is only assembled once a recipient (and therefore a timezone) is known.
 */
describe("#536 — every payload leaves with customer-ready values", () => {
  const ISO = "2026-09-06T02:23:35.600Z";

  const trigger = jest.fn();
  const findMany = jest.fn();

  jest.mock("../../lib/novu/client", () => ({
    isNovuConfigured: () => true,
    getNovuClient: () => ({ trigger, triggerBroadcast: trigger }),
  }));
  jest.mock("../../lib/prisma", () => ({
    __esModule: true,
    default: { user: { findMany: (...args: unknown[]) => findMany(...args) } },
  }));

  /** The payload of the Nth `novu.trigger` call, whatever its recipients. */
  const payloadOf = (call: number): Record<string, unknown> =>
    trigger.mock.calls[call][0].payload;

  beforeEach(() => {
    trigger.mockReset().mockResolvedValue(undefined);
    // Two recipients in different zones: the same instant must reach each of
    // them written in their own time, which one shared payload cannot do.
    findMany.mockReset().mockResolvedValue([
      { id: "u_kolkata", timezone: "Asia/Kolkata" },
      { id: "u_newyork", timezone: "America/New_York" },
    ]);
  });

  const appointmentBase = {
    organizationId: null,
    scope: "personal" as const,
    consultantName: "Sarah Chen",
    consulteeName: "Aarav Anderson",
    planTitle: "Basic Consultation",
    dashboardUrl: "https://example.test/dashboard",
  };

  it("renders one payload per recipient timezone, never an ISO string", async () => {
    const { notifyAppointmentReminder } =
      await import("../../lib/novu/service");

    await notifyAppointmentReminder(["u_kolkata", "u_newyork"], {
      ...appointmentBase,
      appointmentType: "CONSULTATION",
      dateTime: ISO,
    });

    expect(trigger).toHaveBeenCalledTimes(2);
    const rendered = trigger.mock.calls.map((c) => [
      c[0].to,
      c[0].payload.dateTime,
    ]);
    expect(rendered).toEqual([
      ["u_kolkata", "Sun, 6 Sep 2026 · 7:53 AM IST"],
      ["u_newyork", "Sat, 5 Sep 2026 · 10:23 PM EDT"],
    ]);
    // The machine-readable original still travels, under its unit-suffixed name.
    expect(payloadOf(0).dateTimeIso).toBe(ISO);
    // And the shouted enum became a label, with the raw member kept beside it.
    expect(payloadOf(0).appointmentType).toBe("consultation");
    expect(payloadOf(0).appointmentTypeCode).toBe("CONSULTATION");
  });

  it("prints money as money and keeps the paise beside it", async () => {
    const { notifyPaymentSuccess } = await import("../../lib/novu/service");

    await notifyPaymentSuccess("u_kolkata", {
      ...appointmentBase,
      appointmentType: "SUBSCRIPTION",
      amount: 5_567_948,
      currency: "INR",
    });

    expect(payloadOf(0)).toMatchObject({
      // The live template renders `{{currency}} {{amount}}` and cannot be
      // edited today, so `amount` carries no symbol of its own.
      amount: "55,679.48",
      amountFormatted: "₹55,679.48",
      amountPaise: 5_567_948,
      currency: "INR",
      appointmentType: "subscription session",
      // #1484/#1489 — the plan's own title, never the plan id.
      planTitle: "Basic Consultation",
    });
  });

  it("names who cancelled instead of printing the role enum", async () => {
    const { notifyAppointmentCancelled } =
      await import("../../lib/novu/service");

    await notifyAppointmentCancelled(["u_kolkata", "u_newyork"], {
      ...appointmentBase,
      appointmentType: "CONSULTATION",
      cancelledBy: "consultant",
    });

    // One payload reaches both parties, so a relative phrase would be false for
    // one of them; the name is true for both. The live template opens its
    // sentence with this field, and ends it on "Reason: ".
    expect(payloadOf(0)).toMatchObject({
      cancelledBy: "Sarah Chen",
      cancelledByRole: "consultant",
      reason: "No reason given",
    });
  });

  it.each([
    [
      "a system cancellation",
      "system",
      undefined,
      "The platform",
      "No reason given",
    ],
    [
      "a raw enum reason",
      "system",
      "MODERATION",
      "The platform",
      "a moderation decision on this account",
    ],
    [
      "free text a user typed",
      "consultee",
      "I am travelling that week",
      "Aarav Anderson",
      "I am travelling that week",
    ],
  ] as Array<
    [
      string,
      "consultant" | "consultee" | "system",
      string | undefined,
      string,
      string,
    ]
  >)(
    "completes the cancellation sentence for %s",
    async (_name, cancelledBy, reason, expectedBy, expectedReason) => {
      const { notifyAppointmentCancelled } =
        await import("../../lib/novu/service");
      findMany.mockResolvedValue([
        { id: "u_kolkata", timezone: "Asia/Kolkata" },
      ]);

      await notifyAppointmentCancelled(["u_kolkata"], {
        ...appointmentBase,
        appointmentType: "CONSULTATION",
        cancelledBy,
        reason,
      });

      expect(payloadOf(0)).toMatchObject({
        cancelledBy: expectedBy,
        reason: expectedReason,
      });
    },
  );

  const rescheduleCases: Array<
    [string, import("@/lib/novu/workflows").RescheduleOutcomeFields, string]
  > = [
    [
      "MOVED",
      {
        outcome: "MOVED",
        oldDateTime: ISO,
        newDateTime: "2026-09-07T02:23:35.600Z",
      },
      "Mon, 7 Sep 2026 · 7:53 AM IST",
    ],
    [
      "RELEASED",
      { outcome: "RELEASED", oldDateTime: ISO },
      "a new time your consultant will confirm",
    ],
    [
      "WITHDRAWN",
      { outcome: "WITHDRAWN", oldDateTime: ISO },
      "the time it was already booked for",
    ],
  ];

  it.each(rescheduleCases)(
    "a %s reschedule always completes the sentence",
    async (outcome, outcomeFields, expected) => {
      const { notifyAppointmentRescheduled } =
        await import("../../lib/novu/service");
      findMany.mockResolvedValue([
        { id: "u_kolkata", timezone: "Asia/Kolkata" },
      ]);

      await notifyAppointmentRescheduled(["u_kolkata"], {
        ...appointmentBase,
        appointmentType: "CONSULTATION",
        ...outcomeFields,
      });

      expect(payloadOf(0)).toMatchObject({
        outcome,
        oldDateTime: "Sun, 6 Sep 2026 · 7:53 AM IST",
        newDateTime: expected,
      });
    },
  );
});
