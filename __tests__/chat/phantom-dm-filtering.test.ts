/**
 * A DM with nobody on the other end must not be reachable.
 *
 * The first attempt at this only changed the LABEL: `channelUtils` stopped
 * printing the raw channel id and printed "Unavailable conversation" instead.
 * That is cosmetic, and it showed — the row was still in the list, still
 * clickable, still accepted a message. Renaming a broken thing does not fix it.
 *
 * `isUsableDmChannel` is the predicate the sidebar filters on, so a phantom
 * never reaches the rendered list at all. These tests pin the two properties
 * that matter: it catches every under-populated `messaging` channel, and it
 * leaves `team` channels alone — a webinar channel legitimately holds only its
 * host between creation and the first registration, and filtering those would
 * hide working event chats.
 */
import type { Channel } from "stream-chat";

import {
  getChannelDisplayInfo,
  isUsableDmChannel,
} from "@/components/chat/utils/channelUtils";

/** Minimal stand-in — only the fields the predicate and the labeller read. */
function fakeChannel(
  type: "messaging" | "team",
  memberIds: string[],
  data: Record<string, unknown> = {},
): Channel {
  return {
    type,
    id: `${type}-fixture`,
    cid: `${type}:fixture`,
    data,
    state: {
      members: Object.fromEntries(
        memberIds.map((id) => [id, { user: { id, name: `User ${id}` } }]),
      ),
    },
  } as unknown as Channel;
}

describe("isUsableDmChannel", () => {
  it("rejects a messaging channel with no members", () => {
    // The `watch()`-created phantom: `created_by` is set, membership is empty.
    expect(isUsableDmChannel(fakeChannel("messaging", []))).toBe(false);
  });

  it("rejects a messaging channel with only the viewer", () => {
    expect(isUsableDmChannel(fakeChannel("messaging", ["me"]))).toBe(false);
  });

  it("accepts a real two-person DM", () => {
    expect(isUsableDmChannel(fakeChannel("messaging", ["me", "them"]))).toBe(
      true,
    );
  });

  it("accepts a group DM", () => {
    expect(isUsableDmChannel(fakeChannel("messaging", ["me", "a", "b"]))).toBe(
      true,
    );
  });

  it("leaves a one-member team channel alone", () => {
    // A webinar channel is created with its host before anyone registers.
    // Applying the DM rule here would hide a working event chat.
    expect(isUsableDmChannel(fakeChannel("team", ["host"]))).toBe(true);
  });

  it("leaves an empty team channel alone", () => {
    expect(isUsableDmChannel(fakeChannel("team", []))).toBe(true);
  });

  it("survives a channel whose state has not loaded", () => {
    const bare = {
      type: "messaging",
      id: "x",
      cid: "messaging:x",
    } as unknown as Channel;
    expect(isUsableDmChannel(bare)).toBe(false);
  });
});

describe("the label is the last resort, not the fix", () => {
  it("never renders a raw channel id for a broken DM", () => {
    const info = getChannelDisplayInfo(fakeChannel("messaging", ["me"]), "me");

    // The reported symptom was a header reading `dm-cmqb1680e0014txyocn1f0dbz-…`.
    // A channel id is an internal key: it is not a name, and it leaks both
    // participants' user ids into the UI.
    expect(info.displayName).not.toMatch(/^messaging-/);
    expect(info.displayName).toBe("Unavailable conversation");
    expect(info.statusText).toBe("No other participants");
  });

  it("still names the counterparty on a healthy DM", () => {
    const info = getChannelDisplayInfo(
      fakeChannel("messaging", ["me", "them"]),
      "me",
    );
    expect(info.displayName).toBe("User them");
  });
});
