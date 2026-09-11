/**
 * #1064 — the legend and the grid must paint the same colours.
 *
 * The pre-existing legend test asserted only that the consultant legend
 * COVERS every state the grid can render. It did, the whole time the grid was
 * hardcoded to green-300 / yellow-400 / slate-400 / black while the legend
 * rendered from the emerald / amber / slate tokens. Coverage was never the
 * property that mattered; sameness was.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  SLOT_CELL_BASE_CLASS,
  SLOT_STATUS_TOKENS,
  CONSULTANT_LEGEND_KEYS,
  resolveSlotStatusKey,
  slotCellClassName,
  type SlotStatusKey,
} from "@/lib/scheduling/slot-status-tokens";

const KEYS = Object.keys(SLOT_STATUS_TOKENS) as SlotStatusKey[];

const classesOf = (value: string) => value.split(/\s+/).filter(Boolean);

/** Every colour utility on an element, ignoring variants like `hover:`. */
const colourUtilities = (value: string, prefix: string) =>
  classesOf(value).filter(
    (name) => !name.includes(":") && name.startsWith(prefix),
  );

describe("slot palette — cells and legend render the same colours", () => {
  it.each(KEYS)("%s: the cell and its legend swatch share one fill", (key) => {
    const token = SLOT_STATUS_TOKENS[key];

    expect(colourUtilities(slotCellClassName(key), "bg-")).toEqual([
      token.fill,
    ]);
    expect(colourUtilities(token.swatchClassName, "bg-")).toEqual([token.fill]);
  });

  it.each(KEYS)(
    "%s: the cell and its legend swatch share one border",
    (key) => {
      const token = SLOT_STATUS_TOKENS[key];

      expect(colourUtilities(slotCellClassName(key), "border-")).toEqual([
        token.border,
      ]);
      expect(colourUtilities(token.swatchClassName, "border-")).toEqual([
        token.border,
      ]);
    },
  );

  it("no two states are painted the same colour", () => {
    const fills = CONSULTANT_LEGEND_KEYS.map(
      (key) => SLOT_STATUS_TOKENS[key].fill,
    );
    expect(new Set(fills).size).toBe(fills.length);
  });
});

describe("slot palette — the base cell string cannot fight the token", () => {
  /**
   * The reverted attempt (49973623) left `border-transparent` in the base
   * string and appended `border-slate-200` from the token. Two same-specificity
   * border-color utilities on one element resolve by stylesheet order, and
   * Tailwind emits `.border-transparent` last — so the token's border was
   * always discarded and unavailable cells rendered with no outline at all.
   */
  it("carries a border width but no border colour", () => {
    expect(classesOf(SLOT_CELL_BASE_CLASS)).toContain("border");
    expect(colourUtilities(SLOT_CELL_BASE_CLASS, "border-")).toEqual([]);
  });

  it("carries no background of its own", () => {
    expect(colourUtilities(SLOT_CELL_BASE_CLASS, "bg-")).toEqual([]);
  });

  /**
   * The swatch-equality tests above compare token STRINGS, so they are green
   * whether or not the browser paints the string at full strength. That is
   * exactly how `disabled:opacity-50` survived the #1064 palette work: every
   * unavailable cell is disabled, so `bg-slate-200` reached the screen at half
   * over a white card — near enough to the reverted `slate-100` to make a
   * sparse week read as an empty grid again — while the legend swatch, not
   * being a disabled control, showed the true colour. No assertion about token
   * equality can see a variant that fades one side and not the other, so it is
   * pinned directly here.
   */
  it("does not fade every disabled cell", () => {
    const faders = classesOf(SLOT_CELL_BASE_CLASS).filter((name) =>
      name.startsWith("disabled:opacity-"),
    );
    expect(faders).toEqual([]);
  });

  it("still stops disabled cells being clicked", () => {
    expect(classesOf(SLOT_CELL_BASE_CLASS)).toContain(
      "disabled:pointer-events-none",
    );
  });

  /**
   * Fading a cell is legitimate where it is asked for explicitly — a past
   * slot. That path goes through the `faded` option, not the disabled variant,
   * and must keep working.
   */
  it("still fades a cell that asks to be faded", () => {
    expect(classesOf(slotCellClassName("unavailable", { faded: true }))).toContain(
      "opacity-60",
    );
    expect(classesOf(slotCellClassName("unavailable"))).not.toContain(
      "opacity-60",
    );
  });
});

describe("slot palette — Tailwind can see where the tokens live", () => {
  /**
   * The tokens sit in `lib/`, and `content` used to list only `components/`
   * and `app/`. Tailwind emits a utility only if it has SEEN the class in a
   * scanned file, so every token colour that did not coincidentally appear
   * under those two trees was absent from the stylesheet entirely — cells with
   * no fill and no border, which is how the reverted attempt produced a grid
   * whose future days looked blank while past days (painted from a literal in
   * the component) still showed (#1064).
   */
  it("scans the directory the tokens are defined in", () => {
    const config = readFileSync(
      path.join(process.cwd(), "tailwind.config.ts"),
      "utf8",
    );
    expect(config).toContain('"./lib/**/*.{js,ts,jsx,tsx,mdx}"');
  });
});

describe("slot palette — unavailable stays visible", () => {
  /**
   * bg-slate-100 on a white card is what made a sparse week read as an empty
   * grid instead of a full one with little availability. Whatever this token
   * becomes, it may not go back to near-white.
   */
  it("is not a near-white fill", () => {
    expect([
      "bg-white",
      "bg-transparent",
      "bg-slate-50",
      "bg-slate-100",
    ]).not.toContain(SLOT_STATUS_TOKENS.unavailable.fill);
  });

  it("is lighter than a booked slot but darker than nothing", () => {
    expect(SLOT_STATUS_TOKENS.unavailable.fill).not.toBe(
      SLOT_STATUS_TOKENS.fullyBooked.fill,
    );
    expect(SLOT_STATUS_TOKENS.unavailable.border).toBeTruthy();
  });
});

describe("slot palette — the grid resolves states through the tokens", () => {
  const flags = {
    isSelected: false,
    isThisEventSlot: false,
    isRescheduling: false,
    isBookedForDisplay: false,
    isPartiallyBooked: false,
    isAvailable: false,
    isInPast: false,
  };

  it.each([
    ["selected" as const, { isSelected: true }],
    ["thisEvent" as const, { isThisEventSlot: true }],
    ["rescheduling" as const, { isRescheduling: true }],
    ["fullyBooked" as const, { isBookedForDisplay: true }],
    ["partiallyBooked" as const, { isPartiallyBooked: true }],
    ["available" as const, { isAvailable: true }],
    ["unavailable" as const, { isAvailable: true, isInPast: true }],
    ["unavailable" as const, {}],
  ])("resolves to %s", (expected, overrides) => {
    expect(resolveSlotStatusKey({ ...flags, ...overrides })).toBe(expected);
  });

  /**
   * A source scan, deliberately: the drift this file exists to catch was
   * `renderTimeCell` writing colours by hand, and no assertion about the
   * tokens alone can see that happen again.
   */
  it("UnifiedCalendar hardcodes none of the retired slot colours", () => {
    const source = readFileSync(
      path.join(
        process.cwd(),
        "components",
        "scheduling",
        "UnifiedCalendar.tsx",
      ),
      "utf8",
    );

    for (const retired of [
      "bg-green-300",
      "bg-green-700",
      "bg-yellow-400",
      "bg-slate-400",
      "bg-gray-300",
      "bg-amber-400",
      "bg-black",
      "border border-transparent",
    ]) {
      expect(source).not.toContain(retired);
    }
  });
});
