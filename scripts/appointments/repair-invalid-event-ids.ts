#!/usr/bin/env npx tsx
/**
 * Preview/dev helper: find Appointment / Consultation / Subscription /
 * Webinar / Class rows whose primary keys fail `isEventIdFormat`
 * (e.g. hand-crafted `mock0801-appt-pending`).
 *
 * Dry-run by default (lists matches). Destructive delete requires BOTH:
 *   CONFIRM_INVALID_EVENT_ID_REPAIR=yes
 *   --apply
 *
 * NEVER run --apply against production. Refuses unless the configured DB
 * host looks like a preview/branch/local target or ALLOW_SHARED_DB_REPAIR=1
 * is set. Does not print connection strings (Sonar tssecurity:S8689).
 *
 * Usage:
 *   npx tsx scripts/appointments/repair-invalid-event-ids.ts
 *   CONFIRM_INVALID_EVENT_ID_REPAIR=yes npx tsx scripts/appointments/repair-invalid-event-ids.ts --apply
 */

import { isEventIdFormat } from "@/schemas/slotAllocation/validationSchemas";
import prisma from "@/lib/prisma";

type Row = { id: string; label: string };

/** True when the configured DB looks disposable — never logs the URL. */
function databaseLooksDisposable(): boolean {
  if (process.env.ALLOW_SHARED_DB_REPAIR === "1") return true;
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  // Parse host only; never stringify credentials into logs.
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.includes("preview") ||
      host.includes("branch") ||
      host.includes("staging")
    );
  } catch {
    return false;
  }
}

async function collectInvalid(): Promise<Row[]> {
  const bad: Row[] = [];

  const appointments = await prisma.appointment.findMany({
    select: { id: true },
  });
  for (const row of appointments) {
    if (!isEventIdFormat(row.id)) {
      bad.push({ id: row.id, label: "Appointment" });
    }
  }

  const consultations = await prisma.consultation.findMany({
    select: { id: true },
  });
  for (const row of consultations) {
    if (!isEventIdFormat(row.id)) {
      bad.push({ id: row.id, label: "Consultation" });
    }
  }

  const subscriptions = await prisma.subscription.findMany({
    select: { id: true },
  });
  for (const row of subscriptions) {
    if (!isEventIdFormat(row.id)) {
      bad.push({ id: row.id, label: "Subscription" });
    }
  }

  const webinars = await prisma.webinar.findMany({ select: { id: true } });
  for (const row of webinars) {
    if (!isEventIdFormat(row.id)) {
      bad.push({ id: row.id, label: "Webinar" });
    }
  }

  const classes = await prisma.class.findMany({ select: { id: true } });
  for (const row of classes) {
    if (!isEventIdFormat(row.id)) {
      bad.push({ id: row.id, label: "Class" });
    }
  }

  return bad;
}

async function main() {
  const apply = process.argv.includes("--apply");

  console.log(
    process.env.DATABASE_URL ? "DATABASE_URL: configured" : "DATABASE_URL: unset",
  );
  console.log(
    apply
      ? "Mode: APPLY (destructive delete of invalid-id rows)"
      : "Mode: dry-run (report only)",
  );

  if (apply) {
    if (process.env.CONFIRM_INVALID_EVENT_ID_REPAIR !== "yes") {
      console.error(
        "Refusing --apply without CONFIRM_INVALID_EVENT_ID_REPAIR=yes",
      );
      process.exit(1);
    }
    if (!databaseLooksDisposable()) {
      console.error(
        "Refusing --apply: DATABASE_URL does not look like a preview/local DB.",
      );
      console.error(
        "Set ALLOW_SHARED_DB_REPAIR=1 only if you have explicitly confirmed the target.",
      );
      process.exit(1);
    }
  }

  const bad = await collectInvalid();
  if (bad.length === 0) {
    console.log("No invalid event/appointment primary keys found.");
    await prisma.$disconnect();
    return;
  }

  console.log(`Found ${bad.length} invalid primary key(s):`);
  for (const row of bad) {
    console.log(`  - ${row.label}: ${row.id}`);
  }

  if (!apply) {
    console.log(
      "\nDry-run complete. Prefer recreating these rows via the seed suite",
    );
    console.log(
      "(omit explicit ids) or re-run with CONFIRM_INVALID_EVENT_ID_REPAIR=yes --apply",
    );
    console.log("to delete them on a disposable preview DB.");
    await prisma.$disconnect();
    process.exit(2);
  }

  // Delete appointments first when the bad id is an Appointment PK; then
  // orphan event rows. Cascade rules vary — delete by id per model.
  let deleted = 0;
  for (const row of bad) {
    try {
      if (row.label === "Appointment") {
        await prisma.appointment.delete({ where: { id: row.id } });
      } else if (row.label === "Consultation") {
        await prisma.consultation.delete({ where: { id: row.id } });
      } else if (row.label === "Subscription") {
        await prisma.subscription.delete({ where: { id: row.id } });
      } else if (row.label === "Webinar") {
        await prisma.webinar.delete({ where: { id: row.id } });
      } else if (row.label === "Class") {
        await prisma.class.delete({ where: { id: row.id } });
      }
      deleted += 1;
      console.log(`Deleted ${row.label} ${row.id}`);
    } catch (error) {
      console.error(
        `Failed to delete ${row.label} ${row.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  console.log(`Done. Deleted ${deleted}/${bad.length}.`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
