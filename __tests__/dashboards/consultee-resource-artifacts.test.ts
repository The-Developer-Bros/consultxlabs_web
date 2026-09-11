/**
 * @jest-environment node
 */

/**
 * Splitting Resources into Documents and Recordings was done in two steps, and
 * the first one on its own was wrong.
 *
 * Gating the CARD's contents by artifact hid the right things inside each card
 * — but `filteredData`, the tab counts, the default tab and the empty state all
 * still counted every event. So Documents rendered a card for every
 * recording-only session with nothing in it, and the tab badge claimed a number
 * that did not match what was on screen.
 *
 * The fix narrows the event set FIRST and lets everything downstream read the
 * narrowed one. These tests pin that ordering, because the failure mode is
 * quiet: the page looks populated, just with empty cards.
 */

import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const TAB = "components/dashboard/consultee/resources/ResourcesTab.tsx";
const CARD = "components/dashboard/consultee/resources/EventResourceCard.tsx";

describe("the artifact narrows the event set, not just the card", () => {
  const src = read(TAB);

  it("derives an artifact-filtered set before anything counts events", () => {
    expect(src).toContain("const artifactData = useMemo(");

    // Ordering is the whole point: if the narrowing came after the counts, the
    // counts would still be wrong.
    const narrow = src.indexOf("const artifactData = useMemo(");
    const counts = src.indexOf("const totalResources =");
    expect(narrow).toBeGreaterThan(-1);
    expect(counts).toBeGreaterThan(narrow);
  });

  it.each([
    ["totals", "const totalResources =\n    artifactData.consultations.length"],
    ["default tab", "artifactData[t.key as keyof ResourcesData]"],
    ["tab badge counts", "const total = (artifactData[key as keyof ResourcesData] ?? []).length;"],
  ])("%s reads the narrowed set", (_label, needle) => {
    expect(src).toContain(needle);
  });

  it("keeps materials and recordings on opposite sides of the filter", () => {
    const start = src.indexOf("const keep = (events: EventResource[])");
    const block = src.slice(start, start + 320);
    expect(block).toContain('artifact === "materials"');
    expect(block).toContain("e.materials.length > 0");
    expect(block).toContain("e.recordings.length > 0");
  });

  it("hides the two artifact filters unless the view is combined", () => {
    // "With materials" on the Documents page filters nothing; "With recordings"
    // there contradicts the page outright.
    expect(src).toContain('{artifact === "both" && (');
    const start = src.indexOf('{artifact === "both" && (');
    const block = src.slice(start, start + 260);
    expect(block).toContain("with_recordings");
    expect(block).toContain("with_materials");
  });

  it("still gates the card body, so a combined view stays correct", () => {
    const card = read(CARD);
    expect(card).toContain('const showMaterials = artifact === "materials" || artifact === "both"');
    expect(card).toContain('const showRecordings = artifact === "recordings" || artifact === "both"');
    expect(card).toContain("showMaterials && event.materials.length > 0");
    expect(card).toContain("showRecordings && event.recordings.length > 0");
  });
});

describe("the two pages ask for one artifact each", () => {
  it.each([
    ["documents", "materials"],
    ["recordings", "recordings"],
  ])("the %s page requests artifact=%s", (route, artifact) => {
    const src = read(
      `app/dashboard/consultee/[consulteeId]/(features)/${route}/page.tsx`,
    );
    expect(src).toContain(`artifact="${artifact}"`);
  });

  it("both pages share one query key, so opening one warms the other", () => {
    const src = read(
      "components/dashboard/consultee/resources/ConsulteeResourcesPage.tsx",
    );
    expect(src).toContain('queryKey: ["consultee-resources", consulteeId]');
  });

  it("the retired route redirects rather than 404s", () => {
    const src = read(
      "app/dashboard/consultee/[consulteeId]/(features)/resources/page.tsx",
    );
    expect(src).toContain("redirect(");
    expect(src).toContain("/documents");
  });
});
