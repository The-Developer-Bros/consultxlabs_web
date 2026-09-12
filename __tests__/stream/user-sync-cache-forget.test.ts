/**
 * #1593 — a withdrawn STREAM_DATA_PROCESSING consent must not ride the
 * five-minute user sync cache: `withdrawConsent` forgets the user, so the next
 * roster build re-checks them instead of trusting the cache.
 */

import {
  forgetUserSynced,
  isUserSynced,
  markUserSynced,
} from "@/lib/stream-cache";

describe("forgetUserSynced", () => {
  it("drops the sync entry so the next roster build re-checks consent", () => {
    markUserSynced("withdrawn-user");
    expect(isUserSynced("withdrawn-user")).toBe(true);
    forgetUserSynced("withdrawn-user");
    expect(isUserSynced("withdrawn-user")).toBe(false);
  });
});
