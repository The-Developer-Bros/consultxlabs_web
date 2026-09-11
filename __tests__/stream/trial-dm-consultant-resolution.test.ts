/**
 * @jest-environment node
 */

/**
 * #1134 P1-16, second half — the TRIAL branch was unreachable.
 *
 * #1136 added a `TRIAL` case to the payment-success channel provisioning so a
 * trial buyer gets a DM with their consultant. It never ran once.
 *
 * The whole block is guarded by `if (appointmentForChannel && consultantUserId)`,
 * and `consultantUserId` was resolved from four relations — consultation,
 * subscription, webinar, class. A trial appointment has none of them: the
 * consultant hangs off `TrialSession.consultantProfile`, a REQUIRED relation on
 * a model the query did not include at all. So `consultantProfile` came back
 * undefined for exactly the appointments the new branch existed to serve, the
 * guard failed, and the DM was never minted.
 *
 * That is the failure mode the branch was written to fix, reintroduced one
 * layer up: a trial buyer gets video and no way to message the consultant
 * before or after — on the platform's first impression.
 *
 * These assert the resolution ORDER and the trial fallback against the same
 * `||` chain the handler uses. They fail on the four-rung version.
 */

interface Owner {
  userId: string;
}

/** The subset of the handler's appointment shape the chain reads. */
interface AppointmentShape {
  consultation?: { consultationPlan?: { consultantProfile?: Owner } } | null;
  subscription?: { subscriptionPlan?: { consultantProfile?: Owner } } | null;
  webinar?: { webinarPlan?: { consultantProfile?: Owner } } | null;
  class?: { classPlan?: { consultantProfile?: Owner } } | null;
  trialSession?: { consultantProfile?: Owner } | null;
}

/**
 * Lifted from `lib/payments/webhooks/ensure-channels.ts`. A copy, so the test states
 * the contract rather than re-deriving it — the assertion below pins it to the
 * source so the two cannot drift apart silently.
 */
function resolveConsultantUserId(
  appointment: AppointmentShape | null,
): string | undefined {
  const consultantProfile =
    appointment?.consultation?.consultationPlan?.consultantProfile ||
    appointment?.subscription?.subscriptionPlan?.consultantProfile ||
    appointment?.webinar?.webinarPlan?.consultantProfile ||
    appointment?.class?.classPlan?.consultantProfile ||
    appointment?.trialSession?.consultantProfile;
  return consultantProfile?.userId;
}

const owner = (userId: string): Owner => ({ userId });

describe("consultant resolution for the payment-success DM", () => {
  it("resolves a trial from TrialSession, which owns the relation", () => {
    const appointment: AppointmentShape = {
      consultation: null,
      subscription: null,
      webinar: null,
      class: null,
      trialSession: { consultantProfile: owner("consultant-1") },
    };

    // Undefined before the fix — and undefined fails the guard that wraps the
    // whole provisioning block, so no DM at all rather than a wrong one.
    expect(resolveConsultantUserId(appointment)).toBe("consultant-1");
  });

  it("still prefers the paid relation when both are present", () => {
    // A trial that converted keeps its TrialSession row. The appointment being
    // paid for is the subscription, so the subscription's consultant wins.
    const appointment: AppointmentShape = {
      subscription: { subscriptionPlan: { consultantProfile: owner("sub") } },
      trialSession: { consultantProfile: owner("trial") },
    };

    expect(resolveConsultantUserId(appointment)).toBe("sub");
  });

  it.each([
    ["consultation", { consultation: { consultationPlan: { consultantProfile: owner("c") } } }, "c"],
    ["subscription", { subscription: { subscriptionPlan: { consultantProfile: owner("s") } } }, "s"],
    ["webinar", { webinar: { webinarPlan: { consultantProfile: owner("w") } } }, "w"],
    ["class", { class: { classPlan: { consultantProfile: owner("k") } } }, "k"],
  ] as const)("leaves %s resolution unchanged", (_kind, appointment, expected) => {
    expect(resolveConsultantUserId(appointment as AppointmentShape)).toBe(
      expected,
    );
  });

  it("is undefined when nothing owns the appointment", () => {
    // The guard is load-bearing: no consultant means no DM, not a DM to a
    // wrong or empty user id.
    expect(resolveConsultantUserId({})).toBeUndefined();
    expect(resolveConsultantUserId(null)).toBeUndefined();
  });
});

describe("the handler actually does this", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("path") as typeof import("path");
  // #1356 — the channel block moved out of `handlers.ts` into its own module
  // so the reconcile sweep can re-drive it. The pin follows the code; the
  // contract it pins is unchanged.
  const source = readFileSync(
    join(process.cwd(), "lib/payments/webhooks/ensure-channels.ts"),
    "utf8",
  );

  it("includes trialSession in the query", () => {
    // Without the include, the rung below reads a relation Prisma never
    // loaded — always undefined, and no type error to say so.
    expect(source).toContain("trialSession: {");
    // #1446 narrowed the read to a `select` of the ids the step uses, so the
    // relation is now loaded with its own `select` rather than `: true`. The
    // contract the pin states is unchanged: trialSession is loaded, WITH its
    // consultant.
    expect(source).toMatch(
      /trialSession:\s*\{\s*(?:include|select):\s*\{\s*consultantProfile:/,
    );
  });

  it("has the trial rung in the resolution chain", () => {
    expect(source).toContain("appointment.trialSession?.consultantProfile");
  });

  it("uses TrialSession's own consultant, not the plan author's", () => {
    // `TrialSession` also has a required `subscriptionPlan`, and
    // `meeting.action.ts` reads the consultant through THAT. The two can
    // differ, and the person running the trial is the one on the trial row.
    expect(source).not.toContain(
      "trialSession?.subscriptionPlan?.consultantProfile",
    );
  });
});
