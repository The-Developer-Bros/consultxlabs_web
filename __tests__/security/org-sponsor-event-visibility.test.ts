/**
 * @jest-environment node
 */

/**
 * A webinar or class is ONE Appointment shared by every registrant, and
 * checkout tags it with the HOST's org (`plan.organizationId`) rather than the
 * first registrant's — deliberately, so whoever books first does not decide
 * which organization the event belongs to. Per-registrant funding lives on
 * `Payment.organizationId` instead.
 *
 * An earlier revision widened the org list to hosted-OR-funded so a sponsor
 * could see events it paid into. #1166 ORG-8 reversed that: the detail page
 * behind each row 404s anything the org does not OWN, so funded-elsewhere
 * rows were links to a 404, and cross-org funding visibility moved to the
 * money views (which already carry those payments).
 *
 * What this file still pins is the boundary that outlived the reversal: on
 * the rows the list DOES return, a shared appointment may carry registrants
 * from several sponsors and the public, and a sponsor must see the seats it
 * paid for and not the ones it did not.
 */

import { readFileSync } from "fs";
import { join } from "path";

import { buildWhere } from "@/lib/api/scope/list-appointments";

const SRC = readFileSync(
  join(process.cwd(), "lib/api/scope/list-appointments.ts"),
  "utf8",
);

describe("the org list matches org-OWNED rows only (#1166 ORG-8)", () => {
  it("pins organizationId at the top level", () => {
    // List/detail parity: the detail page admits only rows whose
    // organizationId is this org, so the list must not offer more.
    const w = buildWhere({
      scope: { kind: "org", orgId: "acme" },
      userId: "irrelevant",
    }) as Record<string, unknown>;
    expect(w.organizationId).toBe("acme");
    expect(w.OR).toBeUndefined();
  });

  it("no longer matches funded-elsewhere rows through Payment", () => {
    const w = buildWhere({
      scope: { kind: "org", orgId: "acme" },
      userId: "irrelevant",
    });
    expect(JSON.stringify(w)).not.toContain("payment");
  });
});

describe("but only the sponsor's OWN seats are returned", () => {
  it("the payer include is filtered to the viewing org", () => {
    // An unfiltered `payment: true` would hand a sponsor every registrant's
    // identity on a shared webinar — including other sponsors' employees and
    // members of the public. The `where` is the whole guard.
    expect(SRC).toContain("where: { organizationId: params.scope.orgId }");

    const start = SRC.indexOf("payment: {\n                where:");
    expect(start).toBeGreaterThan(-1);
  });

  it("the payer include is attached ONLY on the org scope", () => {
    // `orgMember` is already narrowed to the viewer's own rows and `personal`
    // has no org at all; attaching it there would be meaningless at best.
    expect(SRC).toContain('...(params.scope.kind === "org"');
  });

  it("selects the payer's identity and nothing else from Payment", () => {
    const start = SRC.indexOf("payment: {\n                where:");
    const block = SRC.slice(start, start + 400);

    expect(block).toContain("user: { select: { id: true, name: true, email: true } }");
    // No money on this surface: amounts belong on Billing and Reimbursements,
    // both of which gate on finance permissions rather than operations.read.
    for (const field of ["amount", "amountPaise", "paymentIntent", "status"]) {
      expect(block).not.toContain(`${field}: true`);
    }
  });

  it("still applies no user filter — the org arm is role-gated, not self-scoped", () => {
    const w = buildWhere({
      scope: { kind: "org", orgId: "acme" },
      userId: "u1",
    });
    expect(JSON.stringify(w)).not.toContain("u1");
  });
});
