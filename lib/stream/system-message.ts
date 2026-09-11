import { getStreamChatClient } from "@/lib/stream-client";
import { getChannelTypeFromId } from "@/lib/stream-channel-ids";
import { streamLogger } from "@/lib/stream-logger";

/**
 * Post a system message into a channel.
 *
 * The first `sendMessage` wrapper in the repo — before this, nothing anywhere
 * sent a Stream message from the server at all. It exists because of one
 * specific failure: Stream grants `use-frozen-channel` to no role, so a frozen
 * channel refuses every send with no error text a user ever sees. They type,
 * nothing happens, and there is no visible cause. That is the exact complaint
 * `actions/maintenance/drain-sessions.ts` records about the maintenance freeze,
 * and the retention freeze would have reproduced it on a much larger scale.
 *
 * So the freeze announces itself BEFORE it lands. Order matters and is not
 * incidental: a message sent after the channel is frozen would itself be
 * refused.
 *
 * ## `type: "system"`
 *
 * Not a regular message from a real user. Stream renders system messages
 * distinctly, they carry no sender, and — the operative part — they do not
 * touch the channel's unread counts, so explaining a freeze does not light up
 * an unread badge for a conversation that has just gone read-only.
 */
export async function sendSystemMessage(
  channelId: string,
  text: string,
  custom: Record<string, string> = {},
): Promise<boolean> {
  try {
    const chat = getStreamChatClient();
    await chat
      .channel(getChannelTypeFromId(channelId), channelId)
      // `custom` FIRST. Spread last, a caller key named `type` or `text` would
      // silently override the two fields this function's contract rests on —
      // and `type: "system"` is load-bearing, because a regular message touches
      // unread counts and would light up a badge for a conversation that has
      // just gone read-only. No caller does this today; the ordering is what
      // stops one doing it by accident.
      .sendMessage({ ...custom, text, type: "system" });
    return true;
  } catch (error) {
    // Best-effort by construction. A courtesy notice failing must never stop
    // the lifecycle action it precedes — a channel that freezes without its
    // explanation is the status quo, while a freeze that aborts because the
    // notice failed leaves an unbounded channel alive on a per-MAU bill.
    //
    // Not reported to Sentry: the overwhelmingly common cause is a channel that
    // was never created, because chat is minted lazily on first message. That
    // is the normal case, not an incident.
    streamLogger.debug("System message not delivered", {
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
