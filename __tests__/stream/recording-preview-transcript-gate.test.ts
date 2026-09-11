/**
 * @jest-environment node
 */

/**
 * #1244 review — a preview clip cannot be published without a text
 * alternative.
 *
 * The marketplace copies a short clip of a paid recording into a PUBLIC
 * bucket so anonymous explore cards can play it. A clip carrying speech and
 * no transcript is simply unavailable to anyone who relies on reading, and
 * "the consultant will add one later" is not a gate — publishing is the last
 * moment the platform can insist.
 *
 * The rule lives in a pure helper rather than inline in the route so any
 * future publish surface enforces the same thing instead of reimplementing it.
 */

// The helper is pure, but its module imports the prisma singleton, which
// pulls the prisma singleton and the auth server in at load time, and the
// latter drags better-auth's ESM bundle through Jest's CJS runtime. Stub both
// so the suite exercises the rule, not the auth stack.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { recording: { findUnique: jest.fn() } },
}));
jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(),
}));

import { resolvePreviewTranscript } from "@/lib/stream/recording-listing-access";

describe("resolvePreviewTranscript", () => {
  it("refuses a clip with no transcript anywhere", () => {
    expect(
      resolvePreviewTranscript({
        previewClipUrl: "https://cdn.example/clip.mp4",
        storedTranscript: null,
      }),
    ).toEqual({ ok: false });
  });

  it("refuses a clip whose submitted transcript is only whitespace", () => {
    // Otherwise " " satisfies a min(1) string check and the gate is theatre.
    expect(
      resolvePreviewTranscript({
        previewClipUrl: "https://cdn.example/clip.mp4",
        storedTranscript: null,
        submittedTranscript: "   \n\t ",
      }),
    ).toEqual({ ok: false });
  });

  it("accepts a clip with a submitted transcript, trimmed", () => {
    expect(
      resolvePreviewTranscript({
        previewClipUrl: "https://cdn.example/clip.mp4",
        storedTranscript: null,
        submittedTranscript: "  Welcome to the session.  ",
      }),
    ).toEqual({ ok: true, transcript: "Welcome to the session." });
  });

  it("lets a stored transcript satisfy a re-publish", () => {
    // Editing a listing's title must not demand the transcript be pasted again.
    expect(
      resolvePreviewTranscript({
        previewClipUrl: "https://cdn.example/clip.mp4",
        storedTranscript: "Previously supplied.",
      }),
    ).toEqual({ ok: true, transcript: "Previously supplied." });
  });

  it("prefers a freshly submitted transcript over the stored one", () => {
    expect(
      resolvePreviewTranscript({
        previewClipUrl: "https://cdn.example/clip.mp4",
        storedTranscript: "Stale.",
        submittedTranscript: "Corrected.",
      }),
    ).toEqual({ ok: true, transcript: "Corrected." });
  });

  it("does not gate a thumbnail-only listing", () => {
    // No clip means nothing to describe; requiring a transcript there would
    // block listings that have no audio surface at all.
    expect(
      resolvePreviewTranscript({
        previewClipUrl: null,
        storedTranscript: null,
      }),
    ).toEqual({ ok: true, transcript: null });
  });

  it("still carries a transcript through for a thumbnail-only listing", () => {
    expect(
      resolvePreviewTranscript({
        previewClipUrl: null,
        storedTranscript: null,
        submittedTranscript: "Summary of the replay.",
      }),
    ).toEqual({ ok: true, transcript: "Summary of the replay." });
  });
});
