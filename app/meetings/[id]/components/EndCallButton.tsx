"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useCall } from "@stream-io/video-react-sdk";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { Loader2, PhoneOff } from "lucide-react";
import { leaveCallAndReleaseMedia } from "@/lib/stream/media-teardown";
import { useSessionInfo } from "../session-info";

/** A generous bound on the end request; a healthy round trip is far under it. */
const END_CALL_TIMEOUT_MS = 10_000;

const EndCallButton = () => {
  const call = useCall();
  const router = useRouter();
  const { data: session } = useSession();
  const [isPressed, setIsPressed] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isEnding, setIsEnding] = useState(false);
  const endingRef = useRef(false);

  // Get proper dashboard URL based on user role and profile
  const getDashboardUrl = useCallback(() => {
    if (!session?.user) return "/";

    const { role, consultantProfileId, consulteeProfileId, staffProfileId } =
      session.user;

    if (role === "CONSULTANT" && consultantProfileId) {
      return `/dashboard/consultant/${consultantProfileId}/home`;
    }
    if (role === "CONSULTEE" && consulteeProfileId) {
      return `/dashboard/consultee/${consulteeProfileId}/home`;
    }
    if (role === "STAFF" && staffProfileId) {
      return `/dashboard/staff/${staffProfileId}/home`;
    }

    return "/"; // Fallback to home page
  }, [session]);

  const endCall = useCallback(async () => {
    // #1270 — a ref, not the `isEnding` state. This is invoked from inside a
    // `setProgress` updater, and React may run an updater more than once; both
    // runs close over the same `isEnding === false` and sail past a state
    // guard. That used to mean a duplicate `call.endCall()`; now it means a
    // second POST to the end route.
    if (endingRef.current) return;
    endingRef.current = true;
    setIsEnding(true);

    try {
      // #1270 — the server ends the call, not this button.
      //
      // `call.endCall()` worked because `end-call` is granted to `call_member`
      // and the join route gives every participant that role, so any consultee
      // could end a consultation from devtools; the only barrier was this
      // component not rendering for them. Going through the route means the
      // grant can be revoked without taking the host's own control down with
      // it, and it re-checks host-ness against the database rather than against
      // call data.
      if (call?.id) {
        const response = await fetch(
          `/api/meetings/${encodeURIComponent(call.id)}/end`,
          // `fetch` has no default timeout. Without a bound, a stalled network
          // leaves the host on a disabled "Ending call…" spinner, still
          // broadcasting, with the teardown and navigation in `finally` never
          // reached. Ten seconds is well past a healthy round trip.
          { method: "POST", signal: AbortSignal.timeout(END_CALL_TIMEOUT_MS) },
        );
        if (!response.ok) {
          throw new Error(`End call failed with status ${response.status}`);
        }
      }
    } catch (error) {
      // Navigating away regardless, so the failure is logged rather than
      // blocking the exit. The host still leaves and their media is still
      // released below; the room may simply outlive them, which is what a
      // failed end has always meant.
      console.error("Error ending call:", error);
    } finally {
      // Unconditional, and in `finally`: releasing the hardware used to sit
      // after `endCall()` in the same try, so an endCall that threw took the
      // camera release down with it and the host left the page still
      // broadcasting.
      try {
        await leaveCallAndReleaseMedia(call);
      } catch (error) {
        // Getting the host off this screen matters more than a clean teardown,
        // and a rejection here would strand them on it.
        console.error("Error releasing media while ending call:", error);
      }
      setIsEnding(false);
      endingRef.current = false;
      router.push(getDashboardUrl());
    }
  }, [call, getDashboardUrl, router]);

  useEffect(() => {
    let interval: number;
    if (isPressed) {
      interval = window.setInterval(() => {
        setProgress((prev) => {
          if (prev >= 100) {
            clearInterval(interval);
            endCall();
            return 100;
          }
          return prev + 100 / (5000 / 50); // 5 second duration with 50ms intervals
        });
      }, 50);
    }
    return () => {
      if (interval) clearInterval(interval);
      if (!isPressed) setProgress(0);
    };
  }, [isPressed, endCall]);

  if (!call)
    throw new Error(
      "useStreamCall must be used within a StreamCall component.",
    );

  // Only the host (delivering side) may end the call for everyone. The
  // derivation lives in useSessionInfo — this gates a destructive action, so
  // it must not be a second opinion about who the host is.
  const isHost = useSessionInfo().isHost;

  if (!isHost) return null;

  // Quiet by default and red only as the hold fills. It sits inside the
  // session menu now, so it no longer has to shout to be findable — and it no
  // longer competes with Leave for the eye.
  return (
    <Button
      onMouseDown={() => !isEnding && setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      onMouseLeave={() => setIsPressed(false)}
      // Touch had no way to reach the hold at all, so the control was
      // unusable on a phone.
      onTouchStart={() => !isEnding && setIsPressed(true)}
      onTouchEnd={() => setIsPressed(false)}
      onTouchCancel={() => setIsPressed(false)}
      // Keyboard had no way to reach the hold either: the control is a native
      // <button>, so a keyboard user could focus it and press Enter or Space
      // to no effect at all. `repeat` is ignored so key auto-repeat does not
      // restart the hold, and blur cancels it like leaving with the pointer.
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (!isEnding && !event.repeat) setIsPressed(true);
      }}
      onKeyUp={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        setIsPressed(false);
      }}
      onBlur={() => setIsPressed(false)}
      disabled={isEnding}
      // The hold is the confirmation, so its progress has to be perceivable
      // without seeing the fill.
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress)}
      aria-label={
        isEnding
          ? "Ending the call for everyone"
          : "Hold to end the call for everyone"
      }
      className="relative w-full overflow-hidden border border-red-500/50 bg-transparent text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300 disabled:opacity-70"
      style={{
        background: isEnding
          ? "rgba(185,28,28,1)"
          : `linear-gradient(to right, rgba(239,68,68,0.35) ${progress}%, transparent ${progress}%)`,
      }}
    >
      {isEnding ? (
        <span className="relative z-10 flex items-center gap-2 text-white">
          <Loader2 className="h-4 w-4 animate-spin" />
          Ending call...
        </span>
      ) : (
        <span className="relative z-10 flex items-center gap-2">
          <PhoneOff className="h-4 w-4" />
          {progress > 0 ? "Keep holding…" : "Hold to end for everyone"}
        </span>
      )}
    </Button>
  );
};

export default EndCallButton;
