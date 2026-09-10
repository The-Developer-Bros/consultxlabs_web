/**
 * @jest-environment node
 */

/**
 * #1074 / #1319 — rule 2 of the booking doctrine, made durable.
 *
 * Nothing under scripts/ may hard-delete an Appointment, a request row, or a
 * SlotOfAppointment. A trial cancellation once deleted the appointment and
 * took the Payment row with it (#1074); the abandoned-payment sweep shipped the
 * same shape for another two months. This is a source-text contract: it fails
 * the moment a `delete`/`deleteMany` on those models is reintroduced, which a
 * mock-based test cannot promise.
 *
 * The slot rule is repo-wide rather than sweep-only: four more tentative-hold
 * deletes survived outside `scripts/` until they were converted, so the last
 * case below scans every source tree against a two-entry allowlist.
 */

import fs from "fs";
import path from "path";

const SWEEPS = [
  "scripts/payments/cleanup-abandoned-payments.ts",
  "scripts/appointments/cleanup-invalid-appointments.ts",
  "scripts/appointments/cleanup-stale-pending-consultations.ts",
  "scripts/appointments/cleanup-tentative-slots.ts",
  "scripts/appointments/expire-stale-requests.ts",
  "scripts/appointments/auto-complete-appointments.ts",
];

const FORBIDDEN = [
  /\bconsultation\.delete\(/,
  /\bsubscription\.delete\(/,
  /\bappointment\.delete\(/,
  /\bappointment\.deleteMany\(/,
  /\bconsultation\.deleteMany\(/,
  /\bsubscription\.deleteMany\(/,
  // A Payment row is the money record this whole file exists to keep.
  /\bpayment\.delete\(/,
  /\bpayment\.deleteMany\(/,
  // A tentative hold is freed by status, never by DELETE (doctrine rule 2).
  /\bslotOfAppointment\.delete\(/,
  /\bslotOfAppointment\.deleteMany\(/,
];

// The global slot rule below scans these trees. `utils/` is included because
// the one sanctioned exception lives there, so the allowlist stays honest
// instead of being decorative.
const SLOT_SCAN_ROOTS = ["scripts", "jobs", "lib", "app", "utils"];

/**
 * The allocator's re-planning delete is the deliberate exception: it releases
 * never-paid tentative rows with `payment: { none: {} }` inside the DELETE's
 * own WHERE, so a Payment-bearing appointment is never destroyed. Seed and
 * reset scripts wipe a disposable database and are not booking writes.
 */
const SLOT_DELETE_ALLOWLIST = [
  "utils/slotAllocation/SlotAllocationService.ts",
  "prisma/",
  "scripts/db/",
];

// Tolerates `delete (` and bracket access; Prettier normalises the former,
// but the pin should not depend on it.
const SLOT_DELETE =
  /\bslotOfAppointment(?:\??\.delete(?:Many)?|\[\s*["']delete(?:Many)?["']\s*\])\s*\(/;
// A file entry (no trailing slash) matches exactly; a directory entry matches
// on a path boundary, so `SlotAllocationService.tsx` is not the allocator.
function isAllowlisted(file: string): boolean {
  return SLOT_DELETE_ALLOWLIST.some((ok) =>
    ok.endsWith("/") ? file.startsWith(ok) : file === ok,
  );
}

function walkTypescript(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(process.cwd(), dir), {
    withFileTypes: true,
  })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walkTypescript(rel, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

describe("no sweep hard-deletes a booking row (#1319)", () => {
  for (const file of SWEEPS) {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");

    it(`${file} never deletes a request or appointment`, () => {
      for (const pattern of FORBIDDEN) {
        expect(source).not.toMatch(pattern);
      }
    });
  }

  it("the three sweeps that used to delete slots now soft-cancel them", () => {
    for (const file of [
      "scripts/payments/cleanup-abandoned-payments.ts",
      "scripts/appointments/cleanup-invalid-appointments.ts",
      "scripts/appointments/cleanup-stale-pending-consultations.ts",
    ]) {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      // Single-row deletes in a loop are the #1074 shape; forbid both forms.
      expect(source).not.toMatch(/slotOfAppointment\.delete\(/);
      expect(source).not.toMatch(/slotOfAppointment\.deleteMany\(/);
      expect(source).toContain("transitionSlotCompletion(");
    }
  });

  it("no site outside the allocator hard-deletes a slot", () => {
    // The named-file case above only covered the three sweeps that had
    // already been converted; four more sites kept deleting tentative rows
    // for months. This is the general rule, so a new delete site fails here
    // the moment it is written rather than when someone re-reads the sweeps.
    const offenders = SLOT_SCAN_ROOTS.flatMap((root) => walkTypescript(root))
      .filter((file) => !isAllowlisted(file))
      .filter((file) =>
        SLOT_DELETE.test(
          fs.readFileSync(path.join(process.cwd(), file), "utf8"),
        ),
      );

    expect(offenders).toEqual([]);
  });

  it("the unscheduled approval-payments route is gone (one semantics: EXPIRED)", () => {
    expect(
      fs.existsSync(
        path.join(process.cwd(), "app/api/cleanup/approval-payments/route.ts"),
      ),
    ).toBe(false);
    const sweep = fs.readFileSync(
      path.join(
        process.cwd(),
        "scripts/payments/cleanup-abandoned-payments.ts",
      ),
      "utf8",
    );
    // The lapsed-pay-link cohort expires; REJECTED would read as a decline.
    expect(sweep).not.toContain("AppointmentStatus.REJECTED");
  });
});
