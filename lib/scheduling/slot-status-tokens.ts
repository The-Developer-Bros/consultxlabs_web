/**
 * One colour vocabulary for slot availability.
 *
 * The same four states were painted three different ways depending on which
 * screen you were on:
 *
 *   consultant calendar   green-300 / yellow-400 / slate-400 / black
 *   buyer profile grid    emerald  / amber      / gray      / orange
 *   buyer time picker     emerald-500/10 / amber-500/10 / rose-500/10 (on dark)
 *
 * A consultee who looked at an expert's profile and then opened the picker was
 * reading two different languages for the same information. Worse, none of the
 * three surfaces carried a legend, so the vocabulary was never stated anywhere.
 *
 * These tokens are the single source. Cells and legend swatches are both
 * DERIVED from one `fill`/`border` pair per state, so a swatch cannot document
 * a colour the grid does not paint — which is exactly what happened while the
 * two were written out by hand (#1064).
 */

import { cn } from "@/utils/tailwind";

export type SlotStatusKey =
  | "available"
  | "partiallyBooked"
  | "fullyBooked"
  | "selected"
  | "thisEvent"
  | "rescheduling"
  | "unavailable";

/** The hand-authored half of a token: one colour per state, written once. */
interface SlotStatusPaint {
  label: string;
  hint: string;
  /** Background. Shared by the cell and its legend swatch. */
  fill: string;
  /** Border colour. Shared likewise — see `SLOT_CELL_BASE_CLASS` on why the
   * token owns this and the base string must not. */
  border: string;
  /** Cell label colour. Swatches carry no text. */
  text: string;
  /** Cells only, and only where the cell does something when clicked. */
  hover?: string;
}

export interface SlotStatusToken {
  /** Shown in the legend and in cell tooltips. */
  label: string;
  /** What the state means, for the legend's title attribute. */
  hint: string;
  /** The state's background. Asserted equal across cell and swatch in tests. */
  fill: string;
  /** The state's border colour. */
  border: string;
  /** Cell classes on a light surface. */
  className: string;
  /** Legend swatch — the cell's own fill and border at 12px. */
  swatchClassName: string;
}

const SLOT_STATUS_PAINT: Record<SlotStatusKey, SlotStatusPaint> = {
  available: {
    label: "Available",
    hint: "Free to book.",
    // Deliberately the most saturated light tone on the grid. Free time is the
    // one thing a consultant scans for, and at emerald-100 it came out paler
    // than the slate greys around it — the useful cells receding behind the
    // useless ones (#1064).
    fill: "bg-emerald-200",
    border: "border-emerald-500",
    text: "text-emerald-900",
    hover: "hover:bg-emerald-300",
  },
  partiallyBooked: {
    label: "Partly booked",
    hint: "Some of this interval is taken; a full session may not fit.",
    fill: "bg-amber-200",
    border: "border-amber-400",
    text: "text-amber-900",
    hover: "hover:bg-amber-300",
  },
  fullyBooked: {
    label: "Booked",
    hint: "Already taken.",
    // One shade darker than `unavailable` on purpose — a taken slot is a
    // stronger signal ("someone has this") than an unpublished one ("nobody
    // offered this"), and the same grey on both would collapse the two states
    // once `unavailable` was darkened for visibility (#1064).
    fill: "bg-slate-300",
    border: "border-slate-400",
    text: "text-slate-700",
    hover: "hover:bg-slate-400",
  },
  selected: {
    label: "Selected",
    hint: "You have chosen this time.",
    fill: "bg-emerald-700",
    border: "border-emerald-800",
    text: "text-white",
    hover: "hover:bg-emerald-800",
  },
  thisEvent: {
    label: "This booking",
    hint: "Belongs to the booking you are editing.",
    fill: "bg-zinc-900",
    border: "border-zinc-900",
    text: "text-white",
    hover: "hover:bg-zinc-800",
  },
  rescheduling: {
    label: "Being moved",
    hint: "Released by a reschedule and awaiting a new time.",
    fill: "bg-amber-400",
    border: "border-amber-500",
    text: "text-amber-950",
    hover: "hover:bg-amber-500",
  },
  unavailable: {
    label: "Unavailable",
    hint: "Outside the consultant's published availability.",
    // Was slate-100. On a white card that is nearly indistinguishable from the
    // background, so a sparse week — mostly unavailable cells — read as an
    // EMPTY grid rather than a full one with little availability, which is why
    // the first migration was reverted (#1064, 49973623 / 6b78274e).
    fill: "bg-slate-200",
    border: "border-slate-300",
    text: "text-slate-500",
  },
};

export const SLOT_STATUS_TOKENS: Record<SlotStatusKey, SlotStatusToken> = (
  Object.keys(SLOT_STATUS_PAINT) as SlotStatusKey[]
).reduce(
  (tokens, key) => {
    const paint = SLOT_STATUS_PAINT[key];
    tokens[key] = {
      label: paint.label,
      hint: paint.hint,
      fill: paint.fill,
      border: paint.border,
      className: [paint.fill, paint.text, paint.border, paint.hover]
        .filter(Boolean)
        .join(" "),
      // Same fill, same border, no text colour and no hover: a swatch is a
      // 12px block, not a control.
      swatchClassName: `${paint.fill} ${paint.border}`,
    };
    return tokens;
  },
  {} as Record<SlotStatusKey, SlotStatusToken>,
);

/**
 * Everything a slot cell needs EXCEPT its colour.
 *
 * No border-COLOUR here, only the width. `border-transparent` used to sit in
 * this string and silently beat the token's `border-emerald-500`: Tailwind
 * resolves two same-specificity utilities by their order in the generated
 * stylesheet, where `.border-transparent` is emitted last, not by the order
 * they were concatenated. Unavailable cells therefore lost their outline
 * altogether and read as absent rather than merely faint (#1064).
 *
 * No `disabled:opacity-50` either. EVERY unavailable cell is disabled, so a
 * blanket disabled fade painted `bg-slate-200` at half strength over a white
 * card — near enough to `slate-100` to reproduce, at render time, the exact
 * near-white this file's `unavailable` comment records as reverted. The legend
 * swatch is not a disabled control, so the legend showed the true colour while
 * the grid showed half of it. `disabled:pointer-events-none` stays: not being
 * clickable is the part that was actually wanted. Where a fade IS meant —
 * past cells — `renderTimeCell` and the `faded` option append an explicit
 * `opacity-*`, which is deliberate and unaffected.
 */
export const SLOT_CELL_BASE_CLASS =
  "h-8 w-full relative transition-colors duration-75 ease-in-out border rounded-sm text-[10px] leading-tight px-1 py-0.5 disabled:pointer-events-none";

/**
 * The full class string for one grid cell.
 *
 * Callers pass a state, never a colour — that is what keeps the grid and
 * `SlotStatusLegend` on one palette.
 */
export function slotCellClassName(
  key: SlotStatusKey,
  options?: { faded?: boolean; className?: string },
): string {
  // cn, not a join: Tailwind resolves same-specificity conflicts by position in
  // the GENERATED stylesheet, not by concatenation order — the exact mechanism
  // behind this file's `border-transparent` regression (#1064). A plain join
  // gives the open `className` extension point no protection against a caller
  // passing a conflicting `bg-*`/`border-*`; twMerge makes the last argument
  // win, which is the order a caller would reasonably expect.
  return cn(
    SLOT_CELL_BASE_CLASS,
    SLOT_STATUS_TOKENS[key].className,
    options?.faded && "opacity-60",
    options?.className,
  );
}

/** The booleans a cell resolves through, in the precedence they apply. */
export interface SlotVisualFlags {
  isSelected: boolean;
  isThisEventSlot: boolean;
  isRescheduling: boolean;
  isBookedForDisplay: boolean;
  isPartiallyBooked: boolean;
  isAvailable: boolean;
  isInPast: boolean;
}

/**
 * Which token a cell paints from. The ONE place that decision is made —
 * `UnifiedCalendar.renderTimeCell` calls this rather than hand-rolling its own
 * class string, which is what let the grid and `SlotStatusLegend` drift onto
 * two different palettes in the first place (#1064; reverted attempt
 * 49973623/6b78274e).
 *
 * A past-but-available slot resolves to `unavailable`: it is a real interval,
 * just no longer bookable, and the muted palette says that without inventing
 * a fifth colour family.
 */
export function resolveSlotStatusKey(flags: SlotVisualFlags): SlotStatusKey {
  if (flags.isSelected) return "selected";
  if (flags.isThisEventSlot) return "thisEvent";
  if (flags.isRescheduling) return "rescheduling";
  if (flags.isBookedForDisplay) return "fullyBooked";
  if (flags.isPartiallyBooked) return "partiallyBooked";
  if (flags.isAvailable) return flags.isInPast ? "unavailable" : "available";
  return "unavailable";
}

/** The states worth explaining on a read-only grid. */
export const BUYER_LEGEND_KEYS: SlotStatusKey[] = [
  "available",
  "partiallyBooked",
  "fullyBooked",
  "unavailable",
];

/** Everything the consultant's allocate calendar can show. */
export const CONSULTANT_LEGEND_KEYS: SlotStatusKey[] = [
  "available",
  "selected",
  "partiallyBooked",
  "fullyBooked",
  "thisEvent",
  "rescheduling",
  "unavailable",
];
