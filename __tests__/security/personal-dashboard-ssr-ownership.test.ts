/**
 * The personal dashboard trees enforced ownership in a `useEffect` inside the
 * consultee and consultant layouts. Those are client components, so the check
 * ran only after the server had rendered — and the server pages beneath them
 * took the profile id straight from the URL, handed it to a `lib/data` read,
 * and dehydrated the result into the HTML.
 *
 * `middleware.ts` could not cover for it: it checks that a session cookie is
 * PRESENT, not that it is valid, because validating one needs Node APIs the
 * edge runtime lacks. So any signed-in user could request
 * `/dashboard/consultee/<someone-else>/home` and read that person's
 * appointments, counterparts, plan titles and times out of the response body
 * before the redirect fired. Reading view-source was the whole exploit.
 *
 * Two of the pages made the assumption explicit, in comments asserting that
 * "the dashboard layout already verifies the session user owns `consulteeId`".
 * Their own ownership checks bound the appointment to the URL's profile — never
 * that profile to the session.
 *
 * These tests pin the guard onto every server page that reads by URL id. They
 * are source-level for the reason the sibling security tests are: rendering an
 * RSC tree with a forged session would exercise the harness more than the
 * guard, and what matters is that the call is present and precedes the read.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const CE = "app/dashboard/consultee/[consulteeId]/(features)";
const CA = "app/dashboard/consultant/[consultantId]/(features)";

/** Every server page that fetches with the profile id from its own URL. */
const GUARDED_PAGES: Array<[string, "consultee" | "consultant", string]> = [
  [`${CE}/home/page.tsx`, "consultee", "consulteeId"],
  [`${CE}/appointments/page.tsx`, "consultee", "consulteeId"],
  [`${CE}/appointments/[appointmentId]/page.tsx`, "consultee", "consulteeId"],
  [`${CA}/home/page.tsx`, "consultant", "consultantId"],
  [`${CA}/appointments/page.tsx`, "consultant", "consultantId"],
  // Analytics stopped being its own route when it folded onto Earnings as a
  // tab (ADR 19). The guard did not move with it — `earnings/page.tsx` became
  // a server component specifically so it could keep the SSR prefetch that
  // page owned, which means it has to hold the ownership check too.
  [`${CA}/earnings/page.tsx`, "consultant", "consultantId"],
  [`${CA}/appointments/[appointmentId]/page.tsx`, "consultant", "consultantId"],
];

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("server pages verify profile ownership before reading", () => {
  it.each(GUARDED_PAGES)("%s calls the guard for its own id", (rel, kind, param) => {
    const src = read(rel);
    // `await` is part of the assertion: a bare call satisfies "the guard is
    // present" while letting the page start its read before the async
    // ownership check settles — which is the bug, not the fix.
    expect(src).toContain(
      `await requirePersonalProfileAccess("${kind}", ${param})`,
    );
  });

  it.each(GUARDED_PAGES)("%s guards BEFORE it reads any data", (rel) => {
    const src = read(rel);
    const guard = src.indexOf("await requirePersonalProfileAccess(");
    expect(guard).toBeGreaterThan(-1);

    // A guard placed after the prefetch would still redirect, but the query
    // would already have run against someone else's rows. Collect first, then
    // assert once — every page reads via one of these two.
    const readsAt = ["prefetchQuery", "readAppointmentDetail("]
      .map((call) => src.indexOf(call))
      .filter((at) => at > -1);

    expect(readsAt.length).toBeGreaterThan(0);
    expect(guard).toBeLessThan(Math.min(...readsAt));
  });

  it.each(GUARDED_PAGES)("%s is a server component", (rel) => {
    // `use client` would make the guard a no-op for the SSR payload, which is
    // exactly the bug this file exists to prevent.
    expect(read(rel).slice(0, 200)).not.toContain('"use client"');
  });
});

describe("the guard itself", () => {
  const GUARD = "lib/auth/personal-dashboard-access.ts";

  it("exists and resolves the session rather than trusting the URL", () => {
    expect(existsSync(join(process.cwd(), GUARD))).toBe(true);
    const src = read(GUARD);

    expect(src).toContain("getSession(");
    // The comparison that makes it a guard at all.
    expect(src).toContain("owned === profileId");
    expect(src).toContain('redirect("/dashboard")');
  });

  it("keeps the ADMIN/STAFF inspection carve-out the layouts already allowed", () => {
    const src = read(GUARD);
    // Closing the hole must not quietly narrow who may look — the client
    // layouts permit privileged inspection, and server and client have to
    // agree or the page redirects in a loop.
    expect(src).toContain('user.role === "ADMIN"');
    expect(src).toContain('user.role === "STAFF"');
  });

  it("refuses a banned session", () => {
    expect(read(GUARD)).toContain("session.user.banned === true");
  });
});
