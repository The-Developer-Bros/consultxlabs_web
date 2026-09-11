import { CallingState } from "@stream-io/video-react-sdk";

/**
 * What a non-JOINED call should tell the person sitting in front of it (#1134).
 *
 * The meeting room used to collapse EVERY state that was not `JOINED` into one
 * unexplained spinner. A mid-call network drop, an SFU rebalance, a dead
 * connection the SDK had already given up on, and a first cold join were all
 * the same screen — and the terminal one, `RECONNECTING_FAILED`, had no way out
 * of it. On a paid consultation that reads as the product having crashed.
 *
 * Stream's own semantics, which this mirrors one-for-one:
 *
 *   RECONNECTING         connection lost, the SDK is retrying. Transient.
 *   MIGRATING            the SFU node is rebalancing or shutting down and the
 *                        session is being moved. Transient, and indistinguishable
 *                        from a blip as far as the participant is concerned.
 *   OFFLINE              no network at all. The SDK recovers to RECONNECTING by
 *                        itself once the network returns, so there is nothing to
 *                        press — but "you are offline" is not "we are loading".
 *   RECONNECTING_FAILED  the SDK gave up after consecutive failed attempts. The
 *                        ONLY terminal one, and the only one that needs a
 *                        manual rejoin.
 *   LEFT                 resources released. Rejoining needs a NEW call
 *                        instance, which is why the action is the same rejoin
 *                        path rather than `call.join()` on this one.
 */
export type ConnectionTone = "loading" | "warning" | "terminal";

export interface ConnectionAdvice {
  tone: ConnectionTone;
  title: string;
  description: string;
  /** True only where the SDK will NOT recover on its own. */
  canRejoin: boolean;
}

/** `null` means "connected" — render the call. */
export function describeCallingState(
  callingState: CallingState,
): ConnectionAdvice | null {
  switch (callingState) {
    case CallingState.JOINED:
      return null;

    case CallingState.RECONNECTING:
    case CallingState.MIGRATING:
      return {
        tone: "warning",
        title: "Reconnecting…",
        description:
          "The connection dropped and we are putting it back. Stay on this page — your session is still running.",
        canRejoin: false,
      };

    case CallingState.OFFLINE:
      return {
        tone: "warning",
        title: "You are offline",
        description:
          "Your device has no internet connection. We will reconnect you the moment it comes back.",
        canRejoin: false,
      };

    case CallingState.RECONNECTING_FAILED:
      return {
        tone: "terminal",
        title: "We could not reconnect you",
        description:
          "Several attempts to restore the connection failed. Check that you are online, then rejoin the session.",
        canRejoin: true,
      };

    case CallingState.LEFT:
      return {
        tone: "terminal",
        title: "You have left this session",
        description:
          "You are no longer connected. You can rejoin if the session is still running.",
        canRejoin: true,
      };

    default:
      // IDLE / RINGING / JOINING / UNKNOWN — the ordinary cold path.
      return {
        tone: "loading",
        title: "Connecting…",
        description: "Getting you into the session.",
        canRejoin: false,
      };
  }
}

/**
 * How long Stream waits, after a participant's connection dies, before it
 * treats them as gone.
 *
 * Stream's default is `0`, documented as "allowing the user to remain in the
 * call until their connection restores or the call is ended" — i.e. forever. On
 * a paid consultation that is the wrong default in a way that costs money and
 * data: a participant who shuts their laptop never produces
 * `call.session_participant_left`, so the session never closes. #1134 found
 * 1,417 MeetingSession rows left open exactly this way, which is also why
 * attendance and no-show detection cannot be trusted.
 *
 * Ninety seconds is long enough to survive a lift, a tunnel or a Wi-Fi handover
 * — the SDK is still retrying underneath — and short enough that an abandoned
 * tab closes its own session while the appointment is still in progress.
 */
export const DISCONNECTION_TIMEOUT_SECONDS = 90;
