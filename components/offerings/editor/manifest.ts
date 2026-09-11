/**
 * The offering editor's field manifest.
 *
 * Four dialogs — 3,890 lines — each hand-laid out the same eight sections in a
 * slightly different order with a slightly different grid. The drift was not
 * cosmetic: `imageUrl` exists on all four Prisma models but only two forms
 * rendered an uploader, Class silently hardcoded `sessionDurationInHours` so
 * every class was a one-hour-session class, and the pricing grid was 2/2/2/3
 * columns across the four. Every one of those is the same failure — a layout
 * decision made four times.
 *
 * Here the differences between types are DATA. A manifest lists sections, a
 * section lists fields, and one renderer lays all of them out identically. Add
 * a field to a type and you cannot forget the other three, because the shared
 * sections are literally shared values.
 */

import type { LucideIcon } from "lucide-react";

export type OfferingType =
  | "consultation"
  | "subscription"
  | "webinar"
  | "class";

/**
 * How a field renders. Deliberately a closed set: a manifest that can express
 * anything is just JSX with extra steps, and the whole point is that the four
 * types cannot drift apart.
 */
export type FieldKind =
  | "text"
  | "textarea"
  | "number"
  | "price"
  | "date"
  | "select"
  | "switch"
  | "stringList"
  | "learningOutcomes"
  | "languageLevel"
  | "image";

export interface FieldSpec {
  /** react-hook-form path. */
  name: string;
  kind: FieldKind;
  label: string;
  description?: string;
  placeholder?: string;
  /** Numeric bounds, forwarded to the input. */
  min?: number;
  max?: number;
  step?: number;
  /** `select` only. */
  options?: { value: string; label: string }[];
  /** `price` only — the sibling holding the currency code. */
  currencyName?: string;
  /** `stringList` / `learningOutcomes` only. */
  itemNoun?: string;
  maxItems?: number;
  /**
   * Columns this field occupies in its section grid. Sections are 6-column, so
   * a half-width field is 3 and a third is 2. Expressing width per FIELD rather
   * than per section is what stops one type's pricing row being 2-up and
   * another's 3-up for no reason.
   */
  span?: 2 | 3 | 6;
}

export interface SectionSpec {
  id: string;
  title: string;
  description?: string;
  icon?: LucideIcon;
  fields: FieldSpec[];
  /**
   * A section the manifest cannot express as fields — the class curriculum
   * builder, the FAQ editor, the sessions calendar. The renderer looks the key
   * up in its slot map instead of laying out fields.
   */
  slot?: string;
}

export interface OfferingManifest {
  type: OfferingType;
  /** Used in prose: "Create a webinar", "your class". */
  noun: string;
  sections: SectionSpec[];
}
