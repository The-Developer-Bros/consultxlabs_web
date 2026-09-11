"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useCall } from "@stream-io/video-react-sdk";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { leaveCallAndReleaseMedia } from "@/lib/stream/media-teardown";
import { resolveAppointmentsHref } from "@/lib/labels/personal-dashboard";
import { cn } from "@/utils/tailwind";

/**
 * The way out of the lobby (#1067). There was none: the route dropped you into
 * the setup screen with the browser Back button as the only exit.
 *
 * It releases the camera and microphone BEFORE navigating, through the same
 * `leaveCallAndReleaseMedia` every other exit uses. Unmounting this route
 * already tears down, so this is belt and braces — but a new way out must
 * never become a new way to leave the capture light on, and the teardown is
 * idempotent (disabling a disabled device is a no-op, and an IDLE call
 * short-circuits before `leave()`).
 */
export function ExitMeetingButton({ className }: { className?: string }) {
  const call = useCall();
  const router = useRouter();
  const { data: session } = useSession();
  const [isLeaving, setIsLeaving] = useState(false);
  // The guard is a ref, not the state: state does not update until React
  // re-renders, so two fast clicks both read `false` and both tear down.
  const leavingRef = useRef(false);

  const handleExit = async () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setIsLeaving(true);
    try {
      await leaveCallAndReleaseMedia(call);
    } catch (error) {
      // Swallowed rather than rethrown: an unhandled rejection out of a click
      // handler helps nobody, and the user asked to leave. The media path
      // reports its own failures.
      console.warn("Media teardown failed while leaving setup:", error);
    }
    router.push(resolveAppointmentsHref(session?.user ?? {}));
  };

  return (
    <button
      type="button"
      onClick={handleExit}
      disabled={isLeaving}
      aria-label="Leave setup and go back to your appointments"
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900",
        className,
      )}
    >
      {isLeaving ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <ArrowLeft className="h-4 w-4" />
      )}
      Back to appointments
    </button>
  );
}
