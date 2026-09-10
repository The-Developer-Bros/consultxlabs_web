/**
 * The consultee document upload now accepts `responseToDocumentId`, so a
 * NEEDS_REVISION re-upload threads onto the document it replaces instead of
 * arriving as an unrelated file.
 *
 * That field is caller-supplied, which makes it an IDOR surface: without a
 * check, anyone could thread their upload onto any document id they guessed
 * and have it render inside someone else's review history. These pin both the
 * guard and the threading contract at the source level — standing up the full
 * Supabase upload path to assert a `where` clause would test the mock, not
 * the rule.
 */

import { readFileSync } from "fs";
import { join } from "path";

const ROUTE = join(
  process.cwd(),
  "app/api/appointments/[appointmentId]/documents/route.ts",
);
const UPLOAD_UI = join(
  process.cwd(),
  // Moved out of the consultee route folder: the org appointment detail page
  // renders the same component, and a shared component cannot live inside one
  // tree's route directory.
  "components/appointments/DocumentUpload.tsx",
);

describe("consultee revision upload", () => {
  const src = readFileSync(ROUTE, "utf8");

  it("reads the revision target from the request", () => {
    expect(src).toContain('formData.get("responseToDocumentId")');
  });

  it("scopes the revision target to THIS appointment before linking", () => {
    // The guard must constrain on appointmentId, not just the document id —
    // that constraint is the whole defence. Tombstoned parents are also
    // rejected (a purged document cannot gain a new revision).
    expect(src).toMatch(
      /findFirst\(\{\s*where:\s*\{\s*id:\s*revisionOf,\s*appointmentId,\s*deletedAt:\s*null\s*\}/,
    );
    expect(src).toContain("INVALID_REVISION_TARGET");
  });

  it("rejects with 400 rather than silently dropping the link", () => {
    // Silently ignoring a bad id would leave the learner thinking their
    // revision was threaded when it wasn't.
    const guard = src.slice(src.indexOf("INVALID_REVISION_TARGET"));
    expect(guard).toContain("status: 400");
  });

  it("persists the link on create", () => {
    expect(src).toContain("responseToDocumentId: revisionOf");
  });

  it("threads rather than mutating the rejected document", () => {
    // The original must survive with its reviewNotes — the reviewer needs to
    // see what changed, and an audit needs the history.
    expect(src).not.toMatch(/appointmentDocument\.update\([\s\S]{0,200}revisionOf/);
  });
});

describe("consultee revision UI", () => {
  const ui = readFileSync(UPLOAD_UI, "utf8");

  it("offers a re-upload path on NEEDS_REVISION", () => {
    // The bug this fixes: the only action used to be delete-while-PENDING, so
    // a NEEDS_REVISION document was a dead end.
    expect(ui).toContain('doc.reviewStatus === "NEEDS_REVISION"');
    expect(ui).toContain("Upload revision");
  });

  it("sends the linkage with the upload", () => {
    expect(ui).toContain('formData.append("responseToDocumentId"');
  });

  it("clears the revision link after upload and on cancel", () => {
    // A stale link would silently thread the NEXT unrelated upload onto the
    // same parent.
    expect(ui.match(/setRevisionOf\(null\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
