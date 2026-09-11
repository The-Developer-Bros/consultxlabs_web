/**
 * Org appointment detail reuses the consultee adapter but its URL has orgId,
 * not consulteeId. Without an override the Reschedule overflow never appears.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { safeReturnTo } from "@/lib/navigation/safe-return-to";

const root = process.cwd();
const FALLBACK = "/dashboard/consultee/c1/appointments";

describe("org appointment detail Reschedule affordance", () => {
  it("passes SSR consulteeId into the shared adapter", () => {
    const client = readFileSync(
      path.join(
        root,
        "app/dashboard/organization/[orgId]/appointments/[appointmentId]/DetailPageClient.tsx",
      ),
      "utf8",
    );
    const page = readFileSync(
      path.join(
        root,
        "app/dashboard/organization/[orgId]/appointments/[appointmentId]/page.tsx",
      ),
      "utf8",
    );
    expect(client).toContain("useConsulteeAppointmentsAdapter({");
    expect(client).toContain("consulteeId,");
    expect(page).toContain("consulteeId={profile.id}");
    // Stay under org for detail navigation; reschedule still deep-links out,
    // but carries a returnTo back to this page (#1166).
    expect(client).toContain("detailHref");
    expect(client).toContain("/dashboard/organization/${orgId}/appointments/");
    // The whole expression, not the key: a token check passes just as happily
    // when the wrong org or appointment id is interpolated.
    expect(client).toContain(
      "rescheduleReturnTo: `/dashboard/organization/${orgId}/appointments/${appointmentId}`",
    );
  });

  it("adapter accepts an optional consulteeId and falls back to params/session", () => {
    const src = readFileSync(
      path.join(
        root,
        "components/appointments/consultee/ConsulteeAppointmentsAdapter.tsx",
      ),
      "utf8",
    );
    expect(src).toContain("options?.consulteeId");
    expect(src).toContain("session?.user?.consulteeProfileId");
    // #1166 — the reschedule URL gained an optional returnTo, so the template
    // no longer ends at /reschedule; pin the path and the threading instead.
    expect(src).toContain(
      "/dashboard/consultee/${consulteeId}/appointments/${vm.appointmentId}/reschedule",
    );
    expect(src).toContain("options?.rescheduleReturnTo");
    expect(src).toContain("encodeURIComponent(options.rescheduleReturnTo)");
  });
});

/**
 * The reschedule page router.push()es whatever survives this check, so the
 * contract is behavioural, not textual — these run the validator itself.
 */
describe("returnTo hop safety (#1166)", () => {
  it("keeps the org detail path the adapter sends", () => {
    expect(
      safeReturnTo("/dashboard/organization/o1/appointments/a1", FALLBACK),
    ).toBe("/dashboard/organization/o1/appointments/a1");
  });

  it("preserves query and hash on an otherwise safe path", () => {
    expect(safeReturnTo("/dashboard/x?tab=notes&page=2#top", FALLBACK)).toBe(
      "/dashboard/x?tab=notes&page=2#top",
    );
  });

  it.each([
    ["protocol-relative", "//attacker.example"],
    ["backslash-relative", "/\\attacker.example"],
    ["tab-smuggled backslash", "/\t\\attacker.example"],
    ["newline-smuggled backslash", "/\n\\attacker.example"],
    ["carriage-return-smuggled", "/\r\\attacker.example"],
    ["absolute http", "https://attacker.example/x"],
    ["scheme-relative with credentials", "//user:pw@attacker.example"],
    ["javascript scheme", "javascript:alert(1)"],
    ["bare relative", "dashboard/x"],
  ])("falls back on %s", (_label, raw) => {
    expect(safeReturnTo(raw, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back when the query key repeats and arrives as an array", () => {
    // A regex .test() would coerce this to "/safe,/\\attacker.example".
    expect(safeReturnTo(["/safe", "/\\attacker.example"], FALLBACK)).toBe(
      FALLBACK,
    );
  });

  it("falls back when the parameter is absent", () => {
    expect(safeReturnTo(undefined, FALLBACK)).toBe(FALLBACK);
  });
});

describe("consultant reschedule legend wiring", () => {
  it("SlotPicker sets showConsultantLegend for consultant propose, not consultee", () => {
    const src = readFileSync(
      path.join(root, "components/scheduling/SlotPicker.tsx"),
      "utf8",
    );
    expect(src).toContain('policy.kind === "RESCHEDULE_CONSULTANT"');
    expect(src).toContain("showConsultantLegend");
    // Must not key the consultant legend solely on eventId (consultee also has it).
    expect(src).not.toMatch(
      /showConsultantLegend=\{\s*Boolean\(subject\.eventId\)\s*\}/,
    );
  });

  it("SafeUnifiedCalendar honours showConsultantLegend over mode alone", () => {
    const src = readFileSync(
      path.join(root, "components/scheduling/SafeUnifiedCalendar.tsx"),
      "utf8",
    );
    expect(src).toContain("showConsultantLegend");
    expect(src).toContain("CONSULTANT_LEGEND_KEYS");
  });
});
