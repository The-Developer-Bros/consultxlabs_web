/**
 * @jest-environment node
 */

/**
 * #1319 — the schema-finalization decisions, pinned so a merge conflict cannot
 * silently restore a dropped index or lose a tombstone column.
 */

import fs from "fs";
import path from "path";

const schema = fs.readFileSync(
  path.join(process.cwd(), "prisma/schema.prisma"),
  "utf8",
);

function model(name: string): string {
  const m = new RegExp(`^model ${name} \\{\\n([\\s\\S]*?)^\\}`, "m").exec(
    schema,
  );
  if (!m) throw new Error(`model ${name} not found`);
  return m[1];
}

describe("new booking models", () => {
  it("AppointmentParticipant and BookingStatusHistory exist with their uniques and indexes", () => {
    const p = model("AppointmentParticipant");
    expect(p).toContain("@@unique([appointmentId, userId])");
    expect(p).toContain("@@index([appointmentId, status])");
    expect(p).toContain("@@index([userId, status])");
    expect(p).toContain("@@index([paymentId])");
    const h = model("BookingStatusHistory");
    expect(h).toContain("@@index([entityId, createdAt])");
    expect(h).toContain("entity     BookingHistoryEntity");
  });
});

describe("hygiene", () => {
  it.each([
    "Consultation",
    "Subscription",
    "Webinar",
    "Class",
    "TrialSession",
    "RescheduleRequest",
    "RescheduleProposedSlot",
    "SlotOfAvailabilityWeekly",
    "SlotOfAvailabilityCustom",
    "BookingUtilization",
    "Appointment",
    "SlotOfAppointment",
    "Payment",
    "Refund",
  ])("%s carries a deletedAt tombstone", (name) => {
    expect(model(name)).toMatch(/deletedAt\s+DateTime\?\s+@db\.Timestamptz/);
  });

  it("TrialSession, Webinar and BookingUtilization have no naive DateTime column", () => {
    for (const name of ["TrialSession", "Webinar", "BookingUtilization"]) {
      const naive = model(name)
        .split("\n")
        .filter(
          (l) =>
            /^\s+\w+\s+DateTime\??(\s|$)/.test(l) &&
            !l.includes("@db.Timestamptz"),
        );
      expect(naive).toEqual([]);
    }
  });

  it("the redundant prefix indexes are gone and the org/deletedAt index exists", () => {
    const a = model("Appointment");
    expect(a).not.toMatch(/@@index\(\[subscriptionId\]\)/);
    expect(a).not.toMatch(/@@index\(\[classId\]\)/);
    expect(a).not.toMatch(/@@index\(\[appointmentType\]\)/);
    expect(a).toContain("@@index([organizationId, deletedAt, createdAt])");
    expect(model("Consultation")).not.toMatch(
      /@@index\(\[consultationPlanId\]\)/,
    );
    expect(model("Consultation")).not.toMatch(/@@index\(\[requestedById\]\)/);
    expect(model("Subscription")).not.toMatch(
      /@@index\(\[subscriptionPlanId\]\)/,
    );
    expect(model("Subscription")).not.toMatch(/@@index\(\[requestedById\]\)/);
  });

  it("cancelledBy is a foreign key on both request models", () => {
    expect(model("Consultation")).toContain(
      '@relation("ConsultationCancelledBy"',
    );
    expect(model("Subscription")).toContain(
      '@relation("SubscriptionCancelledBy"',
    );
  });
});

describe("push chain", () => {
  it("db:push is push → sidecars → assert, with the sidecars applied once", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    );
    expect(pkg.scripts["db:push"]).toBe(
      "npm run db:push:schema && npm run db:assert-sidecars",
    );
    expect(pkg.scripts["db:push:schema"]).toContain("db:sidecars");
  });

  it("the STAGED block is the last thing in check-constraints.sql", () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), "prisma/sql/check-constraints.sql"),
      "utf8",
    );
    const staged = sql.indexOf("STAGED FOR THE PRE-MVP RESET");
    expect(staged).toBeGreaterThan(-1);
    // From the start of the banner line, only comment lines may follow.
    const lineStart = sql.lastIndexOf("\n", staged) + 1;
    const after = sql
      .slice(lineStart)
      .split("\n")
      .filter((l) => l.trim() && !l.trimStart().startsWith("--"));
    expect(after).toEqual([]);
  });
});
