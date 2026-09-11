/**
 * @jest-environment node
 */

/**
 * Resumable-onboarding drafts (#onboarding-ux).
 *
 * Covers the session-scoping of the draft server actions, the JSON
 * sanitizer/reviver round-trip that makes wizard state safe for a Prisma Json
 * column, and the size gate.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    onboardingDraft: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}));

jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(),
}));

import {
  clearOnboardingDraftAction,
  loadOnboardingDraftAction,
  saveOnboardingDraftAction,
} from "../../actions/onboarding-draft.action";
import { getSession } from "../../lib/auth-server";
import prisma from "../../lib/prisma";
import {
  ONBOARDING_DRAFT_MAX_BYTES,
  ONBOARDING_DRAFT_PAYLOAD_VERSION,
  ONBOARDING_DRAFT_VERSION_KEY,
  createDraftSaveQueue,
  encodeDraftForSave,
  encodeDraftForSaveDetailed,
  prepareDraftForPersistDetailed,
  readStoredDraftPayload,
  reviveDraftPayload,
  sanitizeDraftValue,
} from "../../utils/onboarding-draft";
import {
  EducationSchema,
  LONG_FORM_TEXT_MAX,
  SHORT_FORM_TEXT_MAX,
  WorkExperienceSchema,
} from "../../schemas/user";
import { AchievementCreateInputSchema } from "../../utils/onboarding";

const mockGetSession = getSession as unknown as jest.Mock;
const mockUpsert = prisma.onboardingDraft.upsert as unknown as jest.Mock;
const mockFindUnique = prisma.onboardingDraft
  .findUnique as unknown as jest.Mock;
const mockDeleteMany = prisma.onboardingDraft
  .deleteMany as unknown as jest.Mock;

// A class NAMED File exercises the structural recognizer without needing the
// DOM File global in the node environment.
class File {}

const USER_ID = "user-1";

describe("sanitizeDraftValue", () => {
  it("drops functions, undefined, and File-like objects but keeps falsy primitives", () => {
    const input = {
      name: "",
      onlineStatus: false,
      attempts: 0,
      notes: null,
      callback: () => "nope",
      missing: undefined,
      attachment: new File(),
      nested: { deep: { deeper: [1, "two", true] } },
    };

    const out = sanitizeDraftValue(input) as Record<string, unknown>;

    expect(out).toEqual({
      name: "",
      onlineStatus: false,
      attempts: 0,
      notes: null,
      nested: { deep: { deeper: [1, "two", true] } },
    });
    expect(out).not.toHaveProperty("callback");
    expect(out).not.toHaveProperty("missing");
    expect(out).not.toHaveProperty("attachment");
  });

  it("converts Dates to ISO strings and drops invalid dates", () => {
    const dob = new Date("1990-06-15T00:00:00.000Z");
    const out = sanitizeDraftValue({ dateOfBirth: dob, bad: new Date(NaN) });
    expect(out).toEqual({ dateOfBirth: "1990-06-15T00:00:00.000Z" });
  });

  it("bounds runaway structures instead of recursing forever", () => {
    const deep = { v: 1 } as Record<string, unknown>;
    let cursor = deep;
    for (let i = 0; i < 50; i++) {
      cursor.next = { v: i };
      cursor = cursor.next as Record<string, unknown>;
    }
    // Must terminate and produce bounded output rather than throw/hang.
    expect(sanitizeDraftValue(deep)).toBeDefined();
  });
});

describe("reviveDraftPayload", () => {
  it("restores date-typed fields from ISO strings produced by the write path", () => {
    const revived = reviveDraftPayload({
      name: "Ada",
      dateOfBirth: "1990-06-15T00:00:00.000Z",
      emailVerified: "2026-08-01T10:00:00.000Z",
      termsAccepted: true,
    });

    expect(revived.dateOfBirth).toBeInstanceOf(Date);
    expect(revived.emailVerified).toBeInstanceOf(Date);
    expect((revived.dateOfBirth as Date).toISOString()).toBe(
      "1990-06-15T00:00:00.000Z",
    );
    expect(revived.name).toBe("Ada");
  });

  it("leaves non-date fields untouched and never throws on garbage", () => {
    expect(reviveDraftPayload(null)).toEqual({});
    expect(reviveDraftPayload("junk")).toEqual({});
    expect(reviveDraftPayload({ dateOfBirth: "not-a-date" })).toHaveProperty(
      "dateOfBirth",
      "not-a-date",
    );
  });
});

describe("encodeDraftForSave", () => {
  it("rejects payloads over the serialized size budget", () => {
    const bloated = { bio: "x".repeat(ONBOARDING_DRAFT_MAX_BYTES + 10) };
    expect(
      encodeDraftForSave({ role: null, currentStep: 0, payload: bloated }),
    ).toBeNull();
  });

  it("accepts a realistic filled consultant form", () => {
    const payload = {
      role: "CONSULTANT",
      name: "Ada",
      weeklySlots: Array.from({ length: 14 }, (_, i) => ({
        startDay: "MONDAY",
        startTimeUtc: i * 30,
        endDay: "MONDAY",
        endTimeUtc: i * 30 + 30,
      })),
    };
    expect(
      encodeDraftForSave({
        role: "CONSULTANT" as never,
        currentStep: 3,
        payload,
      }),
    ).not.toBeNull();
  });
});

describe("saveOnboardingDraftAction", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue({ user: { id: USER_ID } });
    mockUpsert.mockResolvedValue({});
  });

  it("rejects an unauthenticated caller without touching the database", async () => {
    mockGetSession.mockResolvedValue(null);

    await expect(saveOnboardingDraftAction(validInput())).resolves.toEqual({
      success: false,
      error: "Unauthorized",
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects malformed input at the boundary (strict schema)", async () => {
    const result = await saveOnboardingDraftAction({
      ...validInput(),
      currentStep: 999,
    });
    expect(result.success).toBe(false);

    const extraKey = { ...validInput(), smuggled: true };
    await expect(saveOnboardingDraftAction(extraKey)).resolves.toMatchObject({
      success: false,
    });

    const badRole = { ...validInput(), role: "ADMIN" };
    await expect(saveOnboardingDraftAction(badRole)).resolves.toMatchObject({
      success: false,
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("scopes the upsert to the session user and sanitizes before persisting", async () => {
    const input = validInput({
      payload: {
        name: "Ada",
        dateOfBirth: new Date("1990-06-15T00:00:00.000Z"),
        // A known key transiently holding a File mid-upload — the case the
        // sanitizer exists for. (An UNKNOWN key never gets that far now; the
        // structural schema strips it first.)
        image: new File(),
      },
    });

    await expect(saveOnboardingDraftAction(input)).resolves.toEqual({
      success: true,
    });

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const args = mockUpsert.mock.calls[0][0];
    expect(args.where).toEqual({ userId: USER_ID });
    expect(args.create.userId).toBe(USER_ID); // session id, never caller-supplied
    expect(args.create.payload).toEqual({
      name: "Ada",
      dateOfBirth: "1990-06-15T00:00:00.000Z",
      [ONBOARDING_DRAFT_VERSION_KEY]: ONBOARDING_DRAFT_PAYLOAD_VERSION,
    }); // Date stringified, File dropped, generation stamped
  });

  it("refuses payloads exceeding the size budget", async () => {
    const result = await saveOnboardingDraftAction(
      validInput({
        payload: { description: "x".repeat(ONBOARDING_DRAFT_MAX_BYTES) },
      }),
    );
    expect(result).toEqual({
      success: false,
      error: "Invalid or oversized draft payload",
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("loadOnboardingDraftAction", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue({ user: { id: USER_ID } });
  });

  it("rejects an unauthenticated caller", async () => {
    mockGetSession.mockResolvedValue(null);
    await expect(loadOnboardingDraftAction()).resolves.toEqual({
      success: false,
      error: "Unauthorized",
    });
  });

  it("returns null when no draft row exists", async () => {
    mockFindUnique.mockResolvedValue(null);
    await expect(loadOnboardingDraftAction()).resolves.toEqual({
      success: true,
      draft: null,
    });
  });

  it("revives dates when returning a stored snapshot", async () => {
    mockFindUnique.mockResolvedValue({
      role: "CONSULTANT",
      currentStep: 2,
      payload: {
        name: "Ada",
        dateOfBirth: "1990-06-15T00:00:00.000Z",
        [ONBOARDING_DRAFT_VERSION_KEY]: ONBOARDING_DRAFT_PAYLOAD_VERSION,
      },
    });

    const result = await loadOnboardingDraftAction();
    expect(result.success).toBe(true);
    if (!result.success || !result.draft) throw new Error("unreachable");
    expect(result.draft.currentStep).toBe(2);
    expect(result.draft.quarantined).toBe(false);
    expect(result.draft.payload.dateOfBirth).toBeInstanceOf(Date);
  });

  it("quarantines a payload from an older wizard and rewinds the step", async () => {
    // No marker at all — every row written before the marker existed. Resuming
    // at step 3 with the answers discarded would strand the user on a blank
    // later step, so the step goes back to 0 with the payload.
    mockFindUnique.mockResolvedValue({
      role: "CONSULTANT",
      currentStep: 3,
      payload: { name: "Ada", description: "years of notes" },
    });

    await expect(loadOnboardingDraftAction()).resolves.toEqual({
      success: true,
      draft: {
        role: "CONSULTANT",
        currentStep: 0,
        payload: {},
        quarantined: true,
      },
    });
  });
});

describe("clearOnboardingDraftAction", () => {
  it("deletes only the session user's row and is idempotent", async () => {
    mockGetSession.mockResolvedValue({ user: { id: USER_ID } });
    mockDeleteMany.mockResolvedValue({ count: 1 });

    await expect(clearOnboardingDraftAction()).resolves.toEqual({
      success: true,
    });
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
    });

    mockGetSession.mockResolvedValue(null);
    await expect(clearOnboardingDraftAction()).resolves.toMatchObject({
      success: false,
    });
  });
});

describe("createDraftSaveQueue", () => {
  it("serializes tasks in enqueue order even when they would resolve out of order", async () => {
    const queue = createDraftSaveQueue();
    const order: string[] = [];

    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));

    const first = queue.enqueue(async () => {
      await gate; // slow save dispatched EARLY
      order.push("first");
    });
    const second = queue.enqueue(async () => {
      order.push("second"); // fast save dispatched LATE
    });

    expect(order).toEqual([]); // second must wait for the first to settle
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it("runs later tasks even when an earlier task rejected", async () => {
    const queue = createDraftSaveQueue();

    const failing = queue.enqueue(async () => {
      throw new Error("network down");
    });
    await expect(failing).rejects.toThrow("network down");

    await expect(queue.enqueue(async () => "ok")).resolves.toBe("ok");
  });

  it("drain resolves only after every in-flight task has settled", async () => {
    const queue = createDraftSaveQueue();
    let settled = false;
    void queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      settled = true;
    });

    await queue.drain();
    expect(settled).toBe(true);
  });

  it("drain never rejects, even when a drained task failed", async () => {
    const queue = createDraftSaveQueue();
    void queue
      .enqueue(async () => {
        throw new Error("boom");
      })
      .catch(() => {});

    await expect(queue.drain()).resolves.toBeUndefined();
    // Queue stays usable after a failure.
    await expect(queue.enqueue(async () => "next")).resolves.toBe("next");
  });
});

function validInput(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    role: "CONSULTEE",
    currentStep: 1,
    payload: { name: "Ada", termsAccepted: false },
    ...overrides,
  };
}

/**
 * The byte gate must count UTF-8 BYTES, not UTF-16 code units. Every existing
 * size test uses `"x".repeat(...)`, which is pure ASCII — those pass
 * identically against a `.length` implementation, so the property was correct
 * but unpinned. A Devanagari name, a CJK company or an emoji in a bio makes
 * the two differ by up to 4x, and getting it wrong writes payloads several
 * times over the intended cap.
 */
describe("byte gate counts UTF-8 bytes, not JS string length", () => {
  const under = (payload: Record<string, unknown>) =>
    encodeDraftForSave({ role: null, currentStep: 0, payload }) !== null;

  it("rejects a payload that is under the cap in code units but over it in bytes", () => {
    // "क" is 1 UTF-16 code unit but 3 UTF-8 bytes. 30k of them is ~30k
    // .length and ~90k bytes — a `.length` gate would wave this through.
    const devanagari = "\u0915".repeat(30_000);
    expect(devanagari.length).toBeLessThan(ONBOARDING_DRAFT_MAX_BYTES);
    expect(new TextEncoder().encode(devanagari).length).toBeGreaterThan(
      ONBOARDING_DRAFT_MAX_BYTES,
    );
    expect(under({ description: devanagari })).toBe(false);
  });

  it("counts an astral emoji as 4 bytes", () => {
    // Two code units each, four bytes each.
    const emoji = "\u{1F680}".repeat(20_000);
    expect(emoji.length).toBe(40_000);
    expect(new TextEncoder().encode(emoji).length).toBe(80_000);
    expect(under({ description: emoji })).toBe(false);
  });

  it("still accepts an equivalent-length ASCII payload that fits", () => {
    expect(under({ description: "x".repeat(20_000) })).toBe(true);
  });
});

describe("prepareDraftForPersistDetailed reports WHY it refused", () => {
  it("reports OVER_BUDGET with the byte count, so a stuck draft is diagnosable", () => {
    const tooBig = prepareDraftForPersistDetailed({
      role: null,
      currentStep: 0,
      payload: { description: "x".repeat(ONBOARDING_DRAFT_MAX_BYTES + 1) },
    });
    // The byte count rides along so the breadcrumb can show how far over.
    expect(tooBig).toMatchObject({ ok: false, reason: "OVER_BUDGET" });
    expect((tooBig as { bytes: number }).bytes).toBeGreaterThan(
      ONBOARDING_DRAFT_MAX_BYTES,
    );
  });

  it("reports INVALID for a role outside the three draftable flows", () => {
    // STAFF is invite-only and deliberately not draftable — but the caller
    // must be able to tell that apart from "the user wrote too much".
    expect(
      prepareDraftForPersistDetailed({
        role: "STAFF",
        currentStep: 0,
        payload: {},
      }),
    ).toMatchObject({ ok: false, reason: "INVALID" });
  });

  it("encodeDraftForSaveDetailed returns the prepared value on success", () => {
    expect(
      encodeDraftForSaveDetailed({
        role: null,
        currentStep: 1,
        payload: { name: "Asha" },
      }),
    ).toMatchObject({ ok: true, value: { payload: { name: "Asha" } } });
  });

  it("names the biggest field, because 'too large' alone is unactionable", () => {
    // The user cannot see the payload. Without a field name the warning tells
    // them something is wrong and nothing about how to fix it.
    expect(
      prepareDraftForPersistDetailed({
        role: null,
        currentStep: 0,
        payload: {
          bio: "x".repeat(100),
          description: "y".repeat(ONBOARDING_DRAFT_MAX_BYTES),
        },
      }),
    ).toMatchObject({
      ok: false,
      reason: "OVER_BUDGET",
      largestField: "description",
    });
  });
});

/**
 * The payload is a `Json` column: the database enforces nothing about it, and
 * the wizard spreads whatever comes back straight into form state. These are
 * the properties that make that safe.
 */
describe("structural payload contract", () => {
  const prepare = (payload: Record<string, unknown>) =>
    prepareDraftForPersistDetailed({ role: null, currentStep: 0, payload });

  const storedPayload = (payload: Record<string, unknown>) => {
    const result = prepare(payload);
    if (!result.ok)
      throw new Error(`expected a persistable draft: ${result.reason}`);
    return result.value.payload;
  };

  it("strips keys the wizard does not have", () => {
    // Not hostility — wizard versions. A key retired two releases ago would
    // otherwise ride along forever in a row nobody ever reads field-by-field.
    expect(
      storedPayload({ name: "Ada", retiredInV2: "x", neverExisted: {} }),
    ).toEqual({
      name: "Ada",
      [ONBOARDING_DRAFT_VERSION_KEY]: ONBOARDING_DRAFT_PAYLOAD_VERSION,
    });
  });

  it("rejects a non-array where the wizard expects an array", () => {
    // `weeklySlots.map(...)` runs during render, so a scalar here white-screens
    // the wizard — including the "Start over" button that would fix it.
    expect(prepare({ weeklySlots: "MONDAY 09:00" })).toMatchObject({
      ok: false,
      reason: "INVALID",
    });
    expect(prepare({ weeklySlots: [] })).toMatchObject({ ok: true });
  });

  it("keeps values loose, because a draft is by definition incomplete", () => {
    // Half-typed URL, empty required string, a partially-filled object: all
    // legal mid-wizard, all rejected by the real step schemas.
    expect(
      storedPayload({
        linkedinUrl: "https://",
        name: "",
        domain: { id: "" },
        experience: "not-a-number",
      }),
    ).toMatchObject({
      linkedinUrl: "https://",
      name: "",
      domain: { id: "" },
      experience: "not-a-number",
    });
  });

  it("cannot store __proto__ or constructor at the top level", () => {
    // JSON.parse makes these OWN properties, unlike an object literal — this
    // is exactly the shape a hand-crafted server-action argument arrives in.
    const hostile = JSON.parse(
      '{"name":"Ada","__proto__":{"polluted":true},"constructor":{"polluted":true}}',
    ) as Record<string, unknown>;

    const stored = storedPayload(hostile);
    expect(stored).toEqual({
      name: "Ada",
      [ONBOARDING_DRAFT_VERSION_KEY]: ONBOARDING_DRAFT_PAYLOAD_VERSION,
    });
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
    expect(Object.hasOwn(stored, "constructor")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("cannot store __proto__ or constructor nested inside an array item", () => {
    // The top-level schema only guards top-level keys; the sanitizer is what
    // covers every depth below it.
    const hostile = JSON.parse(
      '{"title":"Engineer","__proto__":{"polluted":true},"constructor":{"polluted":true}}',
    ) as Record<string, unknown>;

    const stored = storedPayload({ workExperiences: [hostile] });
    const item = (stored.workExperiences as Record<string, unknown>[])[0];
    expect(item).toEqual({ title: "Engineer" });
    expect(Object.getPrototypeOf(item)).toBe(Object.prototype);
    expect(Object.hasOwn(item, "constructor")).toBe(false);
  });
});

describe("payload generation marker", () => {
  it("stamps the current generation on every save", () => {
    expect(
      prepareDraftForPersistDetailed({
        role: null,
        currentStep: 0,
        payload: { name: "Ada" },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        payload: {
          [ONBOARDING_DRAFT_VERSION_KEY]: ONBOARDING_DRAFT_PAYLOAD_VERSION,
        },
      },
    });
  });

  it("ignores a marker supplied by the caller", () => {
    // The marker describes what the WRITER produced. A client that could set
    // it could make a stale payload look current and defeat the whole check.
    expect(
      prepareDraftForPersistDetailed({
        role: null,
        currentStep: 0,
        payload: {
          name: "Ada",
          [ONBOARDING_DRAFT_VERSION_KEY]: ONBOARDING_DRAFT_PAYLOAD_VERSION + 99,
        },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        payload: {
          [ONBOARDING_DRAFT_VERSION_KEY]: ONBOARDING_DRAFT_PAYLOAD_VERSION,
        },
      },
    });
  });

  it("round-trips a payload it wrote itself", () => {
    const written = prepareDraftForPersistDetailed({
      role: null,
      currentStep: 0,
      payload: {
        name: "Ada",
        dateOfBirth: new Date("1990-06-15T00:00:00.000Z"),
      },
    });
    if (!written.ok) throw new Error("expected a persistable draft");

    const read = readStoredDraftPayload(written.value.payload);
    expect(read.reason).toBeNull();
    expect(read.payload.name).toBe("Ada");
    expect(read.payload.dateOfBirth).toBeInstanceOf(Date);
  });

  it("quarantines a payload from a different generation instead of merging it", () => {
    // Merging is the expensive failure: the user resumes onto a form that
    // LOOKS filled while old keys mean something else now.
    expect(
      readStoredDraftPayload({
        name: "Ada",
        [ONBOARDING_DRAFT_VERSION_KEY]: ONBOARDING_DRAFT_PAYLOAD_VERSION + 1,
      }),
    ).toEqual({ payload: {}, reason: "VERSION" });
  });

  it("quarantines a payload written before the marker existed", () => {
    expect(readStoredDraftPayload({ name: "Ada" })).toEqual({
      payload: {},
      reason: "VERSION",
    });
  });

  it("quarantines a stamped payload that violates the shape contract", () => {
    // Only reachable by editing the row out of band — the writer parses the
    // same schema — but the reader must not assume that.
    expect(
      readStoredDraftPayload({
        weeklySlots: "MONDAY 09:00",
        [ONBOARDING_DRAFT_VERSION_KEY]: ONBOARDING_DRAFT_PAYLOAD_VERSION,
      }),
    ).toEqual({ payload: {}, reason: "SHAPE" });
  });

  it("treats an absent or empty payload as nothing to restore, not a version problem", () => {
    // A row with `{}` is a user who picked a role and stopped; warning them
    // that the form changed would be a lie.
    expect(readStoredDraftPayload({})).toEqual({ payload: {}, reason: null });
    expect(readStoredDraftPayload(null)).toEqual({ payload: {}, reason: null });
    expect(readStoredDraftPayload("junk")).toEqual({
      payload: {},
      reason: null,
    });
  });
});

/**
 * The caps exist for this file's benefit: before them, only two `maxLength`
 * attributes existed anywhere in the onboarding tree, which made a pasted
 * resume the one realistic route to the 64KB payload cap — and crossing it
 * stops autosave for the rest of the run.
 */
describe("free-text caps on the pasteable fields", () => {
  const overLong = "x".repeat(LONG_FORM_TEXT_MAX + 1);
  const atCap = "x".repeat(LONG_FORM_TEXT_MAX);

  it("rejects long-form descriptions past the cap", () => {
    expect(
      WorkExperienceSchema.safeParse({
        company: "Acme",
        title: "Engineer",
        startDate: "2020-01-01",
        description: overLong,
      }).success,
    ).toBe(false);
    expect(
      EducationSchema.safeParse({
        institution: "IIT",
        degree: "BTech",
        description: overLong,
      }).success,
    ).toBe(false);
    expect(
      AchievementCreateInputSchema.safeParse({
        title: "Award",
        description: overLong,
      }).success,
    ).toBe(false);
  });

  it("rejects education activities past the short-form cap", () => {
    expect(
      EducationSchema.safeParse({
        institution: "IIT",
        degree: "BTech",
        activities: "x".repeat(SHORT_FORM_TEXT_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it("accepts text at exactly the cap, so the input's maxLength never traps a user", () => {
    expect(
      WorkExperienceSchema.safeParse({
        company: "Acme",
        title: "Engineer",
        startDate: "2020-01-01",
        description: atCap,
      }).success,
    ).toBe(true);
  });
});
