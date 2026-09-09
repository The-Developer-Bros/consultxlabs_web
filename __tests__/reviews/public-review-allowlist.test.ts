/**
 * @jest-environment node
 */

/**
 * #1300 — what a PUBLIC review read is allowed to contain.
 *
 * The reads used a bare top-level `include:`, which on a root model returns every
 * scalar, and the nested `consulteeProfile` had the same shape — so a named
 * reviewer's `aboutMe`, `goals`, `careerStage`, `skillsToDevelop`,
 * `budgetPreference` and `billingStateCode` were serialised into the landing
 * page's RSC payload. 124 of 142 consultee profiles have `goals` filled in.
 *
 * The failure mode this pins is not that leak, which is fixed, but the NEXT one:
 * with a bare include, every column added to `ConsultantReview` becomes public by
 * default. A staff-only `excludedReason` was added in the same change that added
 * this test. So the assertion is a DENYLIST — a named column may not appear in
 * the public projection — because an allowlist test that merely lists what is
 * there passes the day someone adds a field to both.
 */

import fs from "node:fs";
import path from "node:path";

import {
  publicReviewSelect,
  sanitisePublicReview,
} from "@/lib/data/review-public";

/**
 * Columns that must never reach a public surface, and why.
 *
 * Each of these is either staff moderation material or an identifier that is
 * useful only for correlating a person across rows.
 */
const MUST_NOT_BE_PUBLIC = [
  // Staff's written justification for excluding a rating from the aggregate.
  "excludedReason",
  "excludedByUserId",
  "excludedFromAggregateAt",
  // The reviewer's own cause claim: an input to moderation, not a public label.
  "ratingCause",
  // Edit-trail bookkeeping. `editedAt` IS public — the fact of an edit — but the
  // version number is internal.
  "revisionNo",
  // The session clock, used for recency weighting. Publishing it dates the
  // engagement more precisely than the review's own timestamp does.
  "ratedSessionAt",
  // Moderation tombstone. Public reads filter on it in the WHERE instead, so it
  // never needs to be selected to be honoured.
  "deletedAt",
  // Moves when the CONSULTANT replies, so it cannot be read as "the review
  // changed" — that is exactly the confusion `editedAt` exists to remove.
  "updatedAt",
  // An enumerable id for the reviewer. Nothing renders it, and its only use is
  // joining an anonymous review to a named one by the same person.
  "consulteeProfileId",
] as const;

describe("the public review projection", () => {
  it.each(MUST_NOT_BE_PUBLIC)("does not select %s", (column) => {
    expect(Object.keys(publicReviewSelect)).not.toContain(column);
  });

  it("does not select the reviewer's profile row, only their name and avatar", () => {
    // The leak was here: `consulteeProfile: { include: { user: ... } }` returns
    // every ConsulteeProfile scalar, which is where the reviewer's career goals
    // live. A review card needs a name and a picture.
    const consultee = publicReviewSelect.consulteeProfile.select;
    expect(Object.keys(consultee)).toEqual(["user"]);
    expect(Object.keys(consultee.user.select).sort()).toEqual([
      "image",
      "name",
    ]);
  });

  it("selects the fact of an edit, because BIS asks for edits to be indicated", () => {
    expect(publicReviewSelect.editedAt).toBe(true);
  });
});

describe("sanitisePublicReview", () => {
  const base = {
    isAnonymous: false,
    rating: 5,
    consulteeProfileId: "cp-1",
    appointmentId: "appt-1",
    ratingUnitId: "class:c-1",
    replyBody: "Thanks — glad it helped.",
    repliedAt: new Date("2026-09-01T00:00:00Z"),
    replyDeletedAt: null as Date | null,
    consulteeProfile: { user: { name: "Priya S.", image: null } },
  };

  it("keeps a live reply", () => {
    const out = sanitisePublicReview(base);
    expect(out.replyBody).toBe("Thanks — glad it helped.");
    expect(out.repliedAt).not.toBeNull();
  });

  it("drops a reply staff removed, and does not ship the tombstone", () => {
    // `replyDeletedAt` exists so an abusive reply can be taken down WITHOUT
    // erasing the consumer review underneath it. Every public read returned
    // `replyBody` regardless; it was unreachable only because nothing wrote a
    // reply yet, which is exactly the kind of latency that turns into an
    // incident the week the feature ships.
    const out = sanitisePublicReview({
      ...base,
      replyDeletedAt: new Date("2026-09-02T00:00:00Z"),
    });
    expect(out.replyBody).toBeNull();
    expect(out.repliedAt).toBeNull();
    expect("replyDeletedAt" in out).toBe(false);
  });

  it("still strips the anonymous reviewer, reply or no reply", () => {
    const out = sanitisePublicReview({ ...base, isAnonymous: true });
    expect(out.consulteeProfile).toBeNull();
    expect(out.appointmentId).toBeNull();
    expect(out.ratingUnitId).toBeNull();
    // ...and the reply is the consultant's own words, so it survives.
    expect(out.replyBody).toBe("Thanks — glad it helped.");
  });
});

/**
 * The CALL SITES, not only the helper.
 *
 * The leak survived a change that swapped the sanitiser in all three public review
 * loaders, because the projection is what leaks and the projection is at the call
 * site. A pin on `publicReviewSelect` alone cannot see that, and the three loaders
 * had gone on returning every review scalar and the reviewer's whole
 * ConsulteeProfile row.
 *
 * Globbed over `lib/data/` rather than listing the three files: a fourth public
 * review loader is the same defect, and naming paths would let it ship untested and
 * would break on a pure move.
 */
const DATA_DIR = path.join(process.cwd(), "lib", "data");

/** The argument object of every `consultantReview.findMany(...)` in a file, by
 *  balancing parentheses from the call — a regex cannot match a nested object. */
function reviewReadArgs(source: string): string[] {
  const out: string[] = [];
  const needle = "consultantReview.findMany(";
  let from = 0;
  for (;;) {
    const start = source.indexOf(needle, from);
    if (start === -1) return out;
    let depth = 0;
    let i = start + needle.length - 1;
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")" && --depth === 0) break;
    }
    // Comments stripped: the prose explaining why a bare `include` was wrong must
    // not read as one.
    out.push(source.slice(start, i).replace(/\/\/[^\n]*/g, ""));
    from = i;
  }
}

describe("every public review read in lib/data", () => {
  const files = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({
      f,
      source: fs.readFileSync(path.join(DATA_DIR, f), "utf8"),
    }))
    .flatMap(({ f, source }) =>
      reviewReadArgs(source).map((args, n) => ({
        where: `${f} #${n + 1}`,
        args,
      })),
    );

  it("finds the loaders it is supposed to be guarding", () => {
    // If this drops to zero the suite below is vacuously green, which is the one
    // way a source-derived pin fails silently.
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it.each(files)("$where projects through the allowlist", ({ args }) => {
    expect(args).toContain("select: publicReviewSelect");
  });

  it.each(files)("$where does not use a bare include", ({ args }) => {
    // A top-level `include` on a root model returns every scalar, and every column
    // added to ConsultantReview afterwards becomes public by default.
    expect(args).not.toMatch(/\binclude:/);
  });
});
