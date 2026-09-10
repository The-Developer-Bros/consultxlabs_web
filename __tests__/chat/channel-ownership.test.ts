/**
 * @jest-environment node
 */

/**
 * #1305 review — the `undefined === undefined` hole in the ownership check.
 *
 * `ownerId === viewerId` reads as an identity test and is not one when both
 * sides are absent. Both are reachable independently: `created_by` is missing
 * on a channel whose creator metadata did not come back from the query, and
 * `client.userID` is missing for the moment before the client connects.
 * Together they granted ownership to whoever happened to be looking.
 *
 * It gated two controls in `ChannelInfoAndManageDialog` — Clear Chat, and the
 * remove-member button, which mutates. The comparison had been written twice in
 * that file and was wrong both times, which is why it now lives in one place.
 */

import { viewerOwnsChannel } from "../../components/chat/utils/channelUtils";

describe("viewerOwnsChannel", () => {
  it("is FALSE when both ids are missing", () => {
    // The whole reason this function exists. `undefined === undefined` is true,
    // so the naive comparison handed ownership to every viewer.
    expect(viewerOwnsChannel(undefined, undefined)).toBe(false);
    expect(viewerOwnsChannel(null, null)).toBe(false);
    expect(viewerOwnsChannel(undefined, null)).toBe(false);
  });

  it("is FALSE when either side alone is missing", () => {
    expect(viewerOwnsChannel(undefined, "user-1")).toBe(false);
    expect(viewerOwnsChannel("user-1", undefined)).toBe(false);
  });

  it("is FALSE for an empty string on either side", () => {
    // `"" === ""` is the same trap one layer down: Stream returns an empty
    // string rather than omitting a field often enough to matter.
    expect(viewerOwnsChannel("", "")).toBe(false);
    expect(viewerOwnsChannel("", "user-1")).toBe(false);
    expect(viewerOwnsChannel("user-1", "")).toBe(false);
  });

  it("is TRUE only for a real match", () => {
    expect(viewerOwnsChannel("user-1", "user-1")).toBe(true);
  });

  it("is FALSE for two different users", () => {
    expect(viewerOwnsChannel("user-1", "user-2")).toBe(false);
  });
});
