/**
 * The `org` scope arm of the list helpers carries NO participant filter — it
 * returns every row under the organization, for every member. It was built
 * with `include`, which on a Prisma root model means "every scalar", so the
 * JSON response carried `Recording.recordingUrl` and `AppointmentDocument`'s
 * `fileUrl` / `storagePath` / `description` to anyone holding
 * `operations.read`: OWNER, MAINTAINER, MANAGER and SUPPORT.
 *
 * Neither org table renders any of it — the exposure was invisible in the UI
 * and plain in the network tab. `description`'s own schema comment gives the
 * examples ("resume, ITR, legal document"), and an ITR is an income-tax
 * return.
 *
 * ADR 20 states the rule these tests pin: the organization may see THAT a
 * session happened, not what happened in it. Only the arms that constrain the
 * caller to be a participant on the appointment return the file or the media.
 *
 * Source-level assertions rather than a live query: standing up Prisma plus a
 * seeded org, membership, appointment and recording to observe a missing key
 * would test the seed as much as the selection, and what matters here is which
 * select object each arm reaches for.
 */

import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const RECORDINGS = "lib/api/scope/list-recordings.ts";
const DOCUMENTS = "lib/api/scope/list-documents.ts";
const ORG_SUPPORT_THREADS =
  "app/api/organizations/[orgId]/support-threads/route.ts";

/** The body of the metadata select object, which is what non-participants get. */
function metadataSelectBody(src: string, constName: string): string {
  const start = src.indexOf(`const ${constName} = {`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("} satisfies", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("org-scope payloads never carry session content", () => {
  it("recordings: the metadata select omits every field that reaches the media", () => {
    const body = metadataSelectBody(read(RECORDINGS), "recordingMetadataSelect");

    // Each of these either IS the media or resolves to it.
    for (const field of [
      "recordingUrl",
      "storageUrl",
      "storagePath",
      "thumbnailUrl",
      "previewClipUrl",
      "streamRecordingId",
      "streamCallId",
    ]) {
      expect(body).not.toContain(field);
    }
  });

  it("recordings: the metadata select still carries what the org table renders", () => {
    const body = metadataSelectBody(read(RECORDINGS), "recordingMetadataSelect");

    // RecordingsClient's own RecordingRow interface. Dropping one of these
    // would blank a column rather than protect anything.
    for (const field of [
      "id",
      "title",
      "status",
      "durationInMinutes",
      "recordedAt",
    ]) {
      expect(body).toContain(`${field}: true`);
    }
  });

  it("documents: the metadata select omits the file and its description", () => {
    const body = metadataSelectBody(read(DOCUMENTS), "documentMetadataSelect");

    for (const field of ["fileUrl", "storagePath", "description"]) {
      expect(body).not.toContain(field);
    }
  });

  it("documents: the metadata select still carries what the org table renders", () => {
    const body = metadataSelectBody(read(DOCUMENTS), "documentMetadataSelect");

    // DocumentsClient's own DocumentRow interface.
    for (const field of [
      "id",
      "fileName",
      "reviewStatus",
      "reviewNotes",
      "uploadedByRole",
      "responseToDocumentId",
      "isStorageMissing",
      "uploadedAt",
    ]) {
      expect(body).toContain(`${field}: true`);
    }
  });

  it.each([
    [RECORDINGS, "recordingParticipantSelect", "recordingUrl"],
    [DOCUMENTS, "documentParticipantSelect", "fileUrl"],
  ])(
    "%s: the participant select still returns the content (%s)",
    (rel, constName, field) => {
      const src = read(rel);
      const start = src.indexOf(`const ${constName} = {`);
      expect(start).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf("} satisfies", start));
      expect(body).toContain(`${field}: true`);
    },
  );

  it.each([RECORDINGS, DOCUMENTS])(
    "%s: content is gated on participant scope, not on org membership",
    (rel) => {
      const src = read(rel);

      // `personal` and `orgMember` are exactly the two arms whose `where`
      // pins the caller as a participant. `org` (whole organization) and
      // `all` (admin/staff) are reading other people's sessions.
      expect(src).toContain('params.scope.kind === "personal" ||');
      expect(src).toContain('params.scope.kind === "orgMember"');

      // The bug was `include` on the root model. `select` is what makes the
      // allowlist an allowlist; an `include` reintroduces every scalar.
      const query = src.slice(src.indexOf("findMany({"));
      expect(query).not.toContain("include:");
      expect(query).toContain("isParticipantScope");
    },
  );
});

describe("org support triage never carries conversation content (#support-hub)", () => {
  // A member's support conversation is CONTENT under ADR 20 — it contains
  // their complaints. The org triage endpoint is metadata-only by design;
  // this pins the allowlist so a future `messages:` cannot slip in silently.
  const src = read(ORG_SUPPORT_THREADS);

  it("the metadata select omits the transcript entirely", () => {
    const start = src.indexOf("const THREAD_METADATA_SELECT = {");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("} satisfies", start));

    // No messages relation, no message fields, no free-text fields.
    for (const field of ["messages", "body:", "metadata", "currentNodeId"]) {
      expect(body).not.toContain(field);
    }
  });

  it("the thread query uses a select allowlist, never an include", () => {
    const query = src.slice(src.indexOf("findMany({"));
    expect(query).not.toContain("include:");
    expect(query).toContain("select: THREAD_METADATA_SELECT");
  });

  it("the route documents the ADR-20 rule it enforces", () => {
    expect(src).toContain("METADATA ONLY");
    expect(src).toContain("ADR 20");
  });
});
