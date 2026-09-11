import { z } from "zod";

/**
 * Age of majority gate — DPDP Act 2023 (#1132).
 *
 * India's "child" is anyone under EIGHTEEN (s.2(f)), not the COPPA 13 the
 * privacy policy used to quote. Processing a child's personal data requires
 * verifiable parental consent (s.9(1), Rule 10), and s.9(3) bans behavioural
 * tracking and targeted advertising to children outright. We sell classes and
 * mentoring, so students are squarely in the target market — there is no
 * "we don't serve minors" story that survives contact with the product.
 *
 * Collecting a date of birth to run this check is itself exempt: Fourth
 * Schedule Part B item 6 covers "confirmation by the Data Fiduciary that the
 * Data Principal is not a child, and observance of due diligence under rule
 * 10". So the gate creates no new obligation — it discharges one.
 *
 * Rules 3 and 5-16 commence 13 May 2027 (G.S.R. 846(E)), so this is a deadline
 * rather than a live breach today. It is cheap now and expensive to retrofit
 * once accounts exist, which is why it ships ahead of the deadline.
 */

/** DPDP s.2(f) — a "child" is an individual who has not completed 18 years. */
export const AGE_OF_MAJORITY = 18;

/**
 * Whole years elapsed between `dob` and `asOf`, calendar-correct (an 18th
 * birthday today counts as 18). Returns null for an absent or invalid date.
 *
 * Takes a `Date`, not a string: parsing is Zod's job at the schema boundary
 * (see DateOfBirthSchema), and this helper only does the arithmetic Zod cannot
 * express. `null`/`undefined` are still accepted because `User.dateOfBirth` is
 * nullable in Prisma, so a caller reading a stored profile legitimately has one.
 */
export function ageInYears(
  dob: Date | null | undefined,
  asOf: Date = new Date(),
): number | null {
  if (!dob) return null;
  const d = dob;
  if (Number.isNaN(d.getTime())) return null;

  let age = asOf.getUTCFullYear() - d.getUTCFullYear();
  const monthDelta = asOf.getUTCMonth() - d.getUTCMonth();
  if (
    monthDelta < 0 ||
    (monthDelta === 0 && asOf.getUTCDate() < d.getUTCDate())
  ) {
    age -= 1;
  }
  return age;
}

/**
 * True only when the date of birth is present, sane, and puts the person at or
 * past the age of majority. Fails closed: a missing or future date is NOT an
 * adult, because an unknown age must never be treated as consentable.
 */
export function isAdult(
  dob: Date | null | undefined,
  asOf: Date = new Date(),
): boolean {
  const age = ageInYears(dob, asOf);
  if (age === null) return false;
  // A negative age means the date is in the future — junk input, not an adult.
  if (age < 0) return false;
  // Beyond any plausible human lifespan; treat as a typo rather than accepting.
  if (age > 120) return false;
  return age >= AGE_OF_MAJORITY;
}

/** Copy shown when the gate rejects. Kept here so UI and API cannot drift. */
export const UNDER_AGE_MESSAGE = `You must be at least ${AGE_OF_MAJORITY} years old to use Familiarise.`;

/**
 * #1132 — the DPDP age gate, defined once and reused by every onboarding
 * schema so the wizard's step schemas and the canonical user schema cannot
 * drift apart.
 *
 * India's age of majority is 18 (DPDP s.2(f)); below it, processing requires
 * verifiable parental consent (s.9) and behavioural tracking is prohibited
 * outright (s.9(3)). `dateOfBirth` was previously optional and never checked,
 * so the product had no age gate at all while the privacy policy quoted the
 * COPPA age of 13. Collecting the date purely to confirm non-child status is
 * itself an exempt purpose (Fourth Schedule Part B item 6), so this adds no
 * new obligation.
 *
 */
const INVALID_DOB = "Enter a valid date of birth";

export const DateOfBirthSchema = z
  .union(
    [
      z.date({ invalid_type_error: INVALID_DOB }),
      // #1132 — a string branch rather than `z.coerce.date()`. Coercing first
      // destroys the evidence: `new Date("2001-02-29")` does not throw, it
      // rolls forward to 2001-03-01, so the schema would end up validating a
      // birthday the user never typed.
      //
      // Zod's own string formats do the calendar check — both are leap-year
      // and month-length aware, so no hand-rolled date parsing is needed.
      // `.date()` matches the YYYY-MM-DD the date input emits; `.datetime()`
      // matches the full ISO string a Date becomes after the wizard's JSON
      // round-trip between steps.
      z
        .union([z.string().date(), z.string().datetime()], {
          errorMap: () => ({ message: INVALID_DOB }),
        })
        .transform((s) => new Date(s)),
    ],
    { required_error: "Date of birth is required" },
  )
  .refine((d) => isAdult(d), { message: UNDER_AGE_MESSAGE });
