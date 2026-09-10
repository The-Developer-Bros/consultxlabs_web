/**
 * Dashboard shells must clip document scroll and keep overflow inside <main>.
 * The scroll architecture has NO document lock: body's floor is the stable
 * small viewport (min-h-svh) and shells are exactly one dynamic viewport tall
 * (100dvh − banner), so the document never outgrows the window on /dashboard/*
 * and `<main>` is the only scrollport. These tests pin that arithmetic.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const SHELL_SOURCES = [
  "components/dashboard/PersonalDashboardShell.tsx",
  "components/dashboard/OperatorDashboardShell.tsx",
  // The org shell is the client component; layout.tsx is the server wrapper
  // that only seeds the org-details query and renders no chrome.
  "app/dashboard/organization/[orgId]/OrgDashboardShell.tsx",
  "app/dashboard/org-workspace/[orgWorkspaceId]/OrgWorkspaceShell.tsx",
  "app/dashboard/organization/(switcher)/layout.tsx",
] as const;

/**
 * Full-viewport states INSIDE the dashboard tree (auth gates, profile
 * loading). They must fill the stable viewport, not 100vh — on mobile
 * `min-h-screen` is taller than the visible viewport and re-opens the
 * dead over-scroll the shells otherwise make impossible.
 */
const GATE_STATE_SOURCES = [
  "app/dashboard/consultee/[consulteeId]/layout.tsx",
  "app/dashboard/consultant/[consultantId]/layout.tsx",
  "app/dashboard/organization/[orgId]/OrgDashboardShell.tsx",
] as const;

/** Extract a balanced `{ ... }` block starting at `from` (index of `{`). */
function extractBlock(src: string, from: number): string {
  if (from < 0 || src[from] !== "{") return "";
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return src.slice(from);
}

function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`export function ${name}`);
  if (start < 0) return "";
  const brace = src.indexOf("{", start);
  return src.slice(start, brace) + extractBlock(src, brace);
}

function extractCssRule(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) return "";
  const brace = css.indexOf("{", start);
  return css.slice(start, brace) + extractBlock(css, brace);
}

/** Outer shell root: first `h-screen-maintenance` className in the file. */
function extractShellRoot(src: string): string {
  const marker = "h-screen-maintenance";
  const idx = src.indexOf(marker);
  if (idx < 0) return "";
  const open = src.lastIndexOf("<div", idx);
  const close = src.indexOf(">", idx);
  return open >= 0 && close > open ? src.slice(open, close + 1) : "";
}

function extractMainTags(src: string): string[] {
  return Array.from(src.matchAll(/<main\b[^>]*>/g), (m) => m[0]);
}

describe("dashboard shell overflow contract", () => {
  it.each(SHELL_SOURCES)(
    "%s locks the viewport and scrolls inside main",
    (rel) => {
      const src = read(rel);
      const root = extractShellRoot(src);
      // extractShellRoot returns "" on a miss, so a shell that moved to another
      // file would otherwise fail as a confusing string mismatch rather than a
      // missing root. Fail loudly on the real cause instead.
      if (root === "") {
        throw new Error(`no h-screen-maintenance shell root found in ${rel}`);
      }
      expect(root).toContain("h-screen-maintenance");
      expect(root).toContain("overflow-hidden");

      const mains = extractMainTags(src);
      const scrollMains = mains.filter(
        (tag) =>
          /\bmin-h-0\b/.test(tag) && /\boverflow-y-auto\b/.test(tag),
      );
      expect(scrollMains.length).toBe(1);
      // Flex chain between shell and main must allow shrinking.
      expect(src).toContain("min-h-0");
    },
  );

  it(".h-screen-maintenance uses 100dvh", () => {
    const rule = extractCssRule(read("app/globals.css"), ".h-screen-maintenance");
    expect(rule).toContain("100dvh");
    expect(rule).not.toMatch(/100vh(?![\w-])/);
  });

  it("document never outgrows the viewport on dashboards — no lock machinery", () => {
    // The scroll architecture is lock-free: body's floor is the stable small
    // viewport and shells are exactly 100dvh − banner, so document height
    // equals the viewport on every /dashboard/* route. None of the previous
    // lock mechanisms (JS class toggle, :has() rules, pre-paint script) may
    // quietly come back — they all fought the arithmetic instead of fixing it.
    const rootLayout = read("app/layout.tsx");
    expect(rootLayout).toContain("min-h-svh");
    expect(rootLayout).not.toContain("min-h-screen");
    expect(rootLayout).not.toContain("suppressHydrationWarning");

    const css = read("app/globals.css");
    expect(css).not.toContain("dashboard-scroll-locked");
    expect(css).not.toContain("data-dashboard-shell");

    const dashboardLayout = read("app/dashboard/layout.tsx");
    expect(dashboardLayout).not.toContain("data-dashboard-shell");
    expect(dashboardLayout).not.toContain("DashboardScrollLock");
    expect(
      existsSync(
        join(process.cwd(), "components/dashboard/DashboardScrollLock.tsx"),
      ),
    ).toBe(false);
  });

  it.each(GATE_STATE_SOURCES)(
    "%s gate/loading states fill the STABLE viewport (svh), never 100vh",
    (rel) => {
      const src = read(rel);
      expect(src).toContain("min-h-svh");
      expect(src).not.toContain("min-h-screen");
    },
  );

  it("dashboard loading skeleton never reintroduces a 100vh floor", () => {
    // The consultant/consultee loading branches render
    // PersonalDashboardShellSkeleton -> CollapsibleSidebarSkeleton. The
    // gate-state checks above only read the layout FILES, so a min-h-screen
    // inside the skeleton component would slip past them and re-open the
    // mobile over-scroll. Pin the actual loading markup.
    const skeleton = read("components/dashboard/CollapsibleSidebar.tsx");
    expect(skeleton).not.toMatch(/\bmin-h-screen\b/);
  });

  it("Radix Select's hidden bubble input is pinned app-wide (globals.css)", () => {
    // Radix renders `select[aria-hidden="true"]` with position:absolute and no
    // top/left (primitives#3875, unfixed in 2.2.6). Uncontained, it anchors to
    // the document and extended the dashboard's document scrollHeight ~620px
    // past the viewport — the dead white over-scroll. FormItem is `relative`
    // (form-bound case); this unlayered rule is the sweep for every other
    // Select. It must never be removed or layered.
    const css = read("app/globals.css");
    const rule = extractCssRule(css, 'select[aria-hidden="true"]');
    expect(rule).toContain("top: 0");
    expect(rule).toContain("left: 0");
    // The rule must sit OUTSIDE every @layer block (unlayered = always
    // emitted): walking from the nearest preceding `@layer` opening, its
    // block must be fully closed before the rule starts.
    const ruleAt = css.indexOf(rule);
    const layerAt = css.lastIndexOf("@layer", ruleAt);
    let closedBeforeRule = true;
    if (layerAt >= 0) {
      closedBeforeRule = false;
      let depth = 0;
      for (let i = css.indexOf("{", layerAt); i < ruleAt; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}" && --depth === 0) {
          closedBeforeRule = true;
          break;
        }
      }
    }
    expect(closedBeforeRule).toBe(true);
  });

  it("OfferingEditor action bar is sticky inside main, not fixed to the viewport", () => {
    const editor = read("components/offerings/editor/OfferingEditor.tsx");
    expect(editor).toMatch(/sticky bottom-0/);
    expect(editor).not.toMatch(/fixed\s+inset-x-0\s+bottom-0/);
    // The giant fixed-bar compensator must not come back on the form.
    expect(editor).not.toMatch(/className="[^"]*\bpb-24\b/);
    // The bar must also pin to the bottom edge on SHORT forms (mt-auto inside
    // the flex-column form), not float mid-air after the last section.
    expect(editor).toMatch(/mt-auto/);
  });

  it("editor pages opt into flush-bottom chrome so the bar reaches the edge", () => {
    // Sticky can't pull the bar past its containing block, so the stacked
    // bottom paddings (DashboardContent py-6 + shell wrapper p-4/6/8) left a
    // ~40-56px float below the save bar even when fully scrolled. The
    // content-flush-bottom opt-in zeroes both, for editor pages only.
    const css = read("app/globals.css");
    expect(extractCssRule(css, ".content-flush-bottom")).toContain(
      "padding-bottom: 0",
    );
    expect(
      extractCssRule(css, "main > div:has(> .content-flush-bottom)"),
    ).toContain("padding-bottom: 0");
    for (const rel of [
      "app/dashboard/consultant/[consultantId]/(features)/offerings/[type]/new/page.tsx",
      "app/dashboard/consultant/[consultantId]/(features)/offerings/[type]/[offeringId]/edit/page.tsx",
      "app/dashboard/organization/[orgId]/catalog/[type]/new/page.tsx",
    ]) {
      expect(read(rel)).toContain("content-flush-bottom");
    }
  });

  it("HelpSkeleton does not nest min-h-screen inside the shell", () => {
    const fn = extractFunction(
      read("components/dashboard/DashboardSkeletons.tsx"),
      "HelpSkeleton",
    );
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).not.toContain("min-h-screen");
  });

  it("ProfileSection summary column does not use h-full / % height", () => {
    const src = read(
      "app/dashboard/consultant/[consultantId]/(features)/settings/sections/ProfileSection.tsx",
    );
    const summaryIdx = src.indexOf("Professional Summary");
    expect(summaryIdx).toBeGreaterThan(0);
    // Card opens shortly before the label; bound the check to that card.
    const cardStart = src.lastIndexOf("<div", summaryIdx);
    const cardEnd = src.indexOf("</div>", src.indexOf("min-h-[16rem]", summaryIdx));
    const card = src.slice(cardStart, cardEnd + 6);
    expect(card).not.toMatch(/\bh-full\b/);
    expect(card).not.toContain("h-[calc(100%-6rem)]");
    expect(card).toContain("min-h-[16rem]");
  });

  it("org-workspace loading uses a content skeleton, not a nested full shell", () => {
    const loading = read(
      "app/dashboard/org-workspace/[orgWorkspaceId]/loading.tsx",
    );
    expect(loading).not.toMatch(
      /import\s*\{[^}]*CollapsibleSidebarSkeleton/,
    );
    expect(loading).not.toMatch(/<CollapsibleSidebarSkeleton/);
    expect(loading).not.toContain("h-screen-maintenance");
    expect(loading).toMatch(/import\s*\{[^}]*Skeleton/);
  });
});
