/**
 * Every sidebar item must point at a route that actually has a page.
 *
 * This exists because the IA consolidation broke exactly that invariant: the
 * org settings route was renamed `page.tsx` → `GeneralPanel.tsx` to become a
 * tab, and the replacement `page.tsx` was never created. The sidebar kept
 * rendering "Settings", and every org role got a 404 on click. Nothing caught
 * it — tsc is happy (no import is missing), the tests were happy (nothing
 * imported the page), and the nav array still contained a plausible path.
 *
 * A filesystem check is the only thing that catches this class of bug, so it
 * lives here rather than being left to a manual click-through.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { buildBackofficeNav } from "@/lib/dashboard/backoffice-nav";

const APP = join(process.cwd(), "app/dashboard");

/** A route resolves if any of its candidate segment layouts has a page.tsx. */
function resolves(...candidates: string[]): boolean {
  return candidates.some((c) => existsSync(join(APP, c, "page.tsx")));
}

describe("back-office nav targets resolve", () => {
  it.each(["admin", "staff"] as const)("%s tree", (tree) => {
    const paths = buildBackofficeNav(tree, { showTds: true }).flatMap((g) =>
      g.items.map((i) => i.path),
    );
    expect(paths.length).toBeGreaterThan(0);

    const missing = paths.filter(
      (p) =>
        !resolves(
          tree === "admin" ? `admin/${p}` : `staff/[staffId]/(features)/${p}`,
          // A couple of staff routes sit outside the (features) group.
          tree === "staff" ? `staff/[staffId]/${p}` : `admin/${p}`,
        ),
    );
    expect(missing).toEqual([]);
  });
});

/**
 * The org sidebar is built inside a client component from live query data, so
 * it can't be imported here. Assert against the full set of paths that file
 * declares — a literal list kept in step with the layout, which is still
 * enough to catch a page that stops existing.
 */
describe("org nav targets resolve", () => {
  const ORG_PATHS = [
    "home",
    "my-program",
    "compensation",
    "appointments",
    // Participant surface, org-scoped by route — see the layout comment.
    "messages",
    // Delivery surface: slot allocation for org-funded bookings.
    "requests",
    "members",
    "collaborations",
    "contracts",
    "purchase-orders",
    "catalog",
    "programs",
    "billing",
    "payouts",
    "reimbursements",
    "disputes",
    "documents",
    "recordings",
    // #support-hub — org triage (metadata-only, ADR 20) + CSAT aggregate.
    "support",
    "analytics",
    "audit",
    "consent",
    "settings",
  ];

  it.each(ORG_PATHS)("/%s has a page", (p) => {
    expect(resolves(`organization/[orgId]/${p}`)).toBe(true);
  });

  it("covers every path the layout actually declares", () => {
    // Guards the list above against drift: if someone adds a nav item and
    // forgets to add it here, this fails rather than silently under-testing.
    const layout = readFileSync(
      join(APP, "organization/[orgId]/OrgDashboardShell.tsx"),
      "utf8",
    ) as string;
    // Nav lives in OrgDashboardShell; layout.tsx is the server wrapper that seeds
    // the org-details query. Same split org-workspace already uses.
    // Loose on purpose: items are written both multi-line and inline
    // (`{ name: "Overview", icon: Home, path: "home" }`), and MOBILE_TABS
    // repeats a subset — dedupe handles the overlap.
    const declared = Array.from(
      layout.matchAll(/path: "([a-z0-9-]+)"/g),
      (m) => m[1],
    );

    expect(Array.from(new Set(declared)).sort()).toEqual(
      Array.from(ORG_PATHS).sort(),
    );
  });
});

describe("personal + workspace nav targets resolve", () => {
  const TREES: Array<[string, string, string]> = [
    [
      "consultant",
      "consultant/[consultantId]/layout.tsx",
      "consultant/[consultantId]/(features)",
    ],
    [
      "consultee",
      "consultee/[consulteeId]/layout.tsx",
      "consultee/[consulteeId]/(features)",
    ],
    [
      "org-workspace",
      "org-workspace/[orgWorkspaceId]/OrgWorkspaceShell.tsx",
      "org-workspace/[orgWorkspaceId]",
    ],
  ];

  it.each(TREES)("%s", (_name, layoutRel, routeBase) => {
    const src = readFileSync(join(APP, layoutRel), "utf8");
    const paths = Array.from(
      new Set(Array.from(src.matchAll(/path: "([a-z0-9-]+)"/g), (m) => m[1])),
    );
    expect(paths.length).toBeGreaterThan(0);

    const missing = paths.filter((p) => !resolves(`${routeBase}/${p}`));
    expect(missing).toEqual([]);
  });
});

/**
 * A group header that restates the only item beneath it carries no
 * information — the reader expands "Resources" to find "Resources". This
 * happened twice: once in the org sidebar (a tabbed Resources page inside a
 * Resources group) and once in both personal dashboards (a Support group
 * wrapping a lone Support item).
 *
 * The rule: a labelled group must either hold more than one item, or hold an
 * item whose name differs from the label. A single item that would restate
 * its header belongs in a labelless group instead.
 */
describe("no redundant group nesting", () => {
  it("back-office groups never restate their only item", () => {
    for (const tree of ["admin", "staff"] as const) {
      for (const group of buildBackofficeNav(tree, { showTds: true })) {
        if (!group.label) continue;
        const restates =
          group.items.length === 1 && group.items[0].name === group.label;
        expect({ tree, label: group.label, restates }).toEqual({
          tree,
          label: group.label,
          restates: false,
        });
      }
    }
  });

  it.each([
    ["consultant", "consultant/[consultantId]/layout.tsx"],
    ["consultee", "consultee/[consulteeId]/layout.tsx"],
    ["organization", "organization/[orgId]/OrgDashboardShell.tsx"],
  ])("%s sidebar has no label that equals a lone item name", (_name, rel) => {
    const src = readFileSync(join(APP, rel), "utf8");

    // Deliberately narrow rather than a general parser: match a labelled
    // group whose `items` array opens with a single inline item of the SAME
    // name. That is the exact shape that occurred twice, and a loose
    // heuristic here matched across group boundaries and cried wolf.
    const inlineRestatement =
      /label: "([^"]+)",\s*\n\s*items: \[\{ name: "\1"/g;

    const offenders = Array.from(src.matchAll(inlineRestatement), (m) => m[1]);
    expect(offenders).toEqual([]);
  });
});
