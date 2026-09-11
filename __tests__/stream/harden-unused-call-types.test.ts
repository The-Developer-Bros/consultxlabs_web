/**
 * @jest-environment node
 */

/**
 * #1280 — the three built-in call types this app never uses were permissive
 * enough that a plain `user` could create a call on them and start recording,
 * transcription and broadcasting. Video tokens here are app-wide, so every
 * signed-in user held one that worked on all of them.
 *
 * The catastrophic mistake this file exists to prevent is the strip list ever
 * containing the type the app actually uses. Everyone would lose every call.
 */

import { STREAM_CALL_TYPE } from "../../lib/stream/call-cid";
import {
  UNUSED_TYPES,
  END_USER_ROLES,
  REACH_PERMISSIONS,
  BILLABLE_PERMISSIONS,
} from "../../scripts/stream/harden-unused-call-types";

describe("harden-unused-call-types", () => {
  it("never targets the call type the app actually uses", () => {
    expect(UNUSED_TYPES as readonly string[]).not.toContain(STREAM_CALL_TYPE);
  });

  it("leaves platform-staff roles alone", () => {
    // Staff hold Stream's `admin` via mapRoleToStream, and an operator has to be
    // able to inspect or end a call on any type. `global_read_only` is read-only.
    for (const role of ["admin", "global_admin", "global_read_only"]) {
      expect(END_USER_ROLES).not.toContain(role);
    }
  });

  it("strips every way of reaching a call, including the -any-team variants", () => {
    // `call_member` on `development` held `join-call-any-team`, which is broader
    // than the plain grant and would survive stripping only `join-call`.
    for (const base of ["create-call", "join-call"]) {
      expect(REACH_PERMISSIONS).toContain(base);
      expect(REACH_PERMISSIONS).toContain(`${base}-any-team`);
    }
  });

  it("strips the billable starters too", () => {
    // Stripped even though reach is already gone, so that re-granting reach
    // later cannot silently re-arm the meter (#1160).
    for (const perm of [
      "start-recording",
      "start-transcription",
      "start-broadcasting",
      "start-frame-recording",
    ]) {
      expect(BILLABLE_PERMISSIONS).toContain(perm);
    }
  });

  it("covers the roles an end user can actually hold", () => {
    for (const role of ["user", "guest", "anonymous", "call_member"]) {
      expect(END_USER_ROLES).toContain(role);
    }
  });
});
