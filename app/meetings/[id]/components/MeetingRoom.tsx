"use client";

import { useEffect, useState } from "react";
import {
  CallParticipantsList,
  CallStatsButton,
  CallingState,
  PaginatedGridLayout,
  SpeakerLayout,
  SpeakingWhileMutedNotification,
  useCall,
  useCallStateHooks,
  ToggleAudioPublishingButton,
  ToggleVideoPublishingButton,
  ReactionsButton,
  ScreenShareButton,
} from "@stream-io/video-react-sdk";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import {
  Users,
  LayoutList,
  Grid3X3,
  Monitor,
  X,
  Phone,
  MoreVertical,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import EndCallButton from "./EndCallButton";
import CallEnded from "./CallEnded";
import RecordingControls from "./RecordingControls";
import { ConnectionQualityNotice } from "./ConnectionQualityNotice";
import { ConnectionStateScreen } from "./ConnectionStateScreen";
import { IncomingVideoQualityMenu } from "./IncomingVideoQualityMenu";
import { useMeetingRecording } from "../hooks/useMeetingRecording";
import {
  sessionHeading,
  useSessionClock,
  useSessionInfo,
} from "../session-info";
import {
  DISCONNECTION_TIMEOUT_SECONDS,
  describeCallingState,
} from "@/lib/stream/connection-state";
import { leaveCallAndReleaseMedia } from "@/lib/stream/media-teardown";
import { cn } from "@/utils/tailwind";
import { StreamVideoErrorBoundary } from "@/components/stream/StreamErrorBoundary";

type CallLayoutType = "grid" | "speaker-left" | "speaker-right";

type CallLayoutProps = {
  layout: string;
};

const CallLayout = ({ layout }: CallLayoutProps) => {
  switch (layout) {
    case "grid":
      return <PaginatedGridLayout />;
    case "speaker-right":
      return <SpeakerLayout participantsBarPosition="left" />;
    default:
      return <SpeakerLayout participantsBarPosition="right" />;
  }
};

const layoutOptions = [
  { value: "grid", label: "Grid View", icon: Grid3X3 },
  { value: "speaker-left", label: "Speaker (Left)", icon: Monitor },
  { value: "speaker-right", label: "Speaker (Right)", icon: Monitor },
];

/**
 * The clock pill, isolated.
 *
 * `useSessionClock` ticks once a second for the whole session. Called from the
 * top of MeetingRoom it re-rendered the entire video layout on every tick,
 * including the many ticks whose output is identical. Only these twenty-odd
 * nodes actually change, so only they subscribe.
 */
function SessionClockPill({
  startsAt,
  endsAt,
}: {
  startsAt: Date | null;
  endsAt: Date | null;
}) {
  const clock = useSessionClock(startsAt, endsAt);
  if (!clock.elapsed) return null;

  return (
    <div
      className={cn(
        "pointer-events-auto flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 backdrop-blur-sm",
        clock.phase === "overrunning"
          ? "border-amber-500/40 bg-amber-500/10"
          : "border-zinc-800 bg-zinc-900/80",
      )}
    >
      <div
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          clock.phase === "overrunning"
            ? "bg-amber-400"
            : "animate-pulse bg-white",
        )}
      />
      {/* What remains leads; the clock since the start is context
                beneath it and now says which one it is. Two unlabelled
                durations side by side read as contradicting each other. */}
      <span
        className={cn(
          "text-sm font-medium",
          clock.phase === "overrunning" ? "text-amber-200" : "text-white",
        )}
      >
        {clock.status}
      </span>
      <span
        className={cn(
          "hidden text-xs tabular-nums sm:inline",
          clock.phase === "overrunning" ? "text-amber-300/80" : "text-zinc-500",
        )}
      >
        {clock.elapsedLabel}
      </span>
    </div>
  );
}

interface MeetingRoomProps {
  /**
   * Recovery from a terminal connection state. Re-creating the call is the
   * SDK's documented requirement — see useGetCallById.
   */
  onRejoin: () => void;
}

const MeetingRoom = ({ onRejoin }: MeetingRoomProps) => {
  const router = useRouter();
  const { data: session } = useSession();
  const [layout, setLayout] = useState<CallLayoutType>("speaker-left");
  const [showParticipants, setShowParticipants] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const call = useCall();
  const { useCallCallingState, useCallEndedAt, useParticipantCount } =
    useCallStateHooks();

  // Get recording info for this meeting
  const { meetingSessionId, recordingEnabled } = useMeetingRecording(call?.id);

  const callingState = useCallCallingState();
  const callEndedAt = useCallEndedAt();
  const participantCount = useParticipantCount();

  // #1134 — Stream's default disconnection timeout is 0, i.e. a participant
  // whose connection dies stays in the call indefinitely and never emits
  // `call.session_participant_left`. That is where the 1,417 MeetingSession
  // rows that never closed came from, and why attendance cannot be trusted.
  useEffect(() => {
    call?.setDisconnectionTimeout(DISCONNECTION_TIMEOUT_SECONDS);
  }, [call]);

  const { useCallCustomData } = useCallStateHooks();
  const custom = useCallCustomData();

  const info = useSessionInfo();

  // #org-appts — host/guest by WHICH SIDE of THIS appointment the viewer is
  // on. `isHost` comes from useSessionInfo, which owns the one definition.
  const consulteeUserId = custom?.consulteeUserId as string | undefined;
  const isHost = info.isHost;
  const isGuest = consulteeUserId
    ? session?.user?.id === consulteeUserId
    : session?.user?.role === "CONSULTEE";

  // Get proper dashboard URL based on user role and profile
  const getDashboardUrl = () => {
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

    return "/";
  };

  // Release the hardware before navigating. The teardown is shared with the
  // page unmount and the end-call path so every exit behaves the same way, and
  // so no single failure can skip the rest of it.
  const cleanupAndNavigate = async (targetUrl: string) => {
    // A deliberate exit passes through LEFT on its way out. Without this it
    // would flash "You have left this session — Rejoin?" at someone who just
    // pressed Leave and is already being navigated away.
    setIsLeaving(true);
    try {
      await leaveCallAndReleaseMedia(call);
    } catch (error) {
      console.error("Error releasing media while leaving call:", error);
    } finally {
      // In `finally`: a teardown that rejects must not be the reason the user
      // is left sitting on the call screen.
      router.push(targetUrl);
    }
  };

  // Handle return to home with proper cleanup
  const handleReturnHome = async () => {
    await cleanupAndNavigate(getDashboardUrl());
  };

  if (callEndedAt && !isHost) {
    return (
      <CallEnded
        message="The call has been ended by the host"
        onRejoin={onRejoin}
        onReturnHome={handleReturnHome}
      />
    );
  }

  // #1134 — everything that was not JOINED used to collapse into one
  // unexplained spinner, so a network blip, an SFU migration and a connection
  // the SDK had permanently given up on all looked identical, and the terminal
  // one had no way out. `describeCallingState` owns which is which.
  const advice = callEndedAt
    ? null
    : isLeaving
      ? {
          tone: "loading" as const,
          title: "Leaving…",
          description: "Releasing your camera and microphone.",
          canRejoin: false,
        }
      : describeCallingState(callingState);
  if (advice) {
    return (
      <ConnectionStateScreen
        advice={advice}
        isOffline={callingState === CallingState.OFFLINE}
        onRejoin={onRejoin}
        onLeave={handleReturnHome}
      />
    );
  }

  return (
    <StreamVideoErrorBoundary>
      <section className="relative h-screen w-full overflow-hidden bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950">
        {/* Background pattern */}
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiNmZmYiIGZpbGwtb3BhY2l0eT0iMC4wMiI+PGNpcmNsZSBjeD0iMzAiIGN5PSIzMCIgcj0iMiIvPjwvZz48L2c+PC9zdmc+')] opacity-50" />

        {/* Main content area */}
        <div className="relative flex h-full w-full">
          {/* Video Grid Area - Centered with proper padding for controls */}
          <div className="flex-1 flex items-center justify-center px-6 pt-16 pb-24">
            <div className="w-full h-full max-w-6xl flex items-center justify-center">
              <CallLayout layout={layout} />
            </div>
          </div>

          {/* Participants Sidebar */}
          <div
            className={cn(
              "fixed right-0 top-0 h-full w-full sm:w-80 bg-zinc-900/95 backdrop-blur-xl border-l border-zinc-800 transform transition-transform duration-300 ease-in-out z-40",
              showParticipants ? "translate-x-0" : "translate-x-full",
            )}
          >
            <div className="flex items-center justify-between p-4 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-zinc-400" />
                <span className="font-semibold text-white">Participants</span>
                <span className="px-2 py-0.5 bg-zinc-800 rounded-full text-xs text-zinc-400">
                  {participantCount}
                </span>
              </div>
              <button
                onClick={() => setShowParticipants(false)}
                className="p-2 hover:bg-zinc-800 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-zinc-400" />
              </button>
            </div>
            <div className="h-[calc(100%-60px)] overflow-y-auto">
              <CallParticipantsList
                onClose={() => setShowParticipants(false)}
              />
            </div>
          </div>

          {/* Overlay when sidebar is open on mobile */}
          {showParticipants && (
            <div
              className="fixed inset-0 bg-black/50 z-30 lg:hidden"
              onClick={() => setShowParticipants(false)}
            />
          )}
        </div>

        {/* Bottom Control Bar */}
        <div className="fixed bottom-0 left-0 right-0 z-50">
          <div className="flex items-center justify-center px-4 py-4">
            <div className="flex flex-wrap items-center justify-center gap-2 px-4 py-3 bg-zinc-900/90 backdrop-blur-xl rounded-2xl border border-zinc-800 shadow-2xl max-w-[calc(100vw-2rem)]">
              {/* Custom Call Controls - Replaces default CallControls */}
              {/* Audio Toggle. The notification came free with the SDK's
                  `CallControls` and was lost when these buttons were
                  hand-rolled — so someone talking into a muted mic got no hint
                  at all, which on a paid consultation is minutes of a session
                  spent unheard. */}
              <SpeakingWhileMutedNotification>
                <ToggleAudioPublishingButton />
              </SpeakingWhileMutedNotification>

              {/* Video Toggle */}
              <ToggleVideoPublishingButton />

              {/* Reactions */}
              <ReactionsButton />

              {/* Screen Share */}
              <ScreenShareButton />

              {/* Recording BUTTON for the host - Left of Leave Call (only if recording enabled) */}
              {isHost && recordingEnabled && meetingSessionId && (
                <RecordingControls
                  meetingSessionId={meetingSessionId}
                  recordingEnabled={recordingEnabled}
                  showOnlyButton={true}
                />
              )}

              {/* Leave — the only red control in the bar, and the only exit
                  reachable in one click. */}
              <button
                onClick={async () => {
                  await cleanupAndNavigate(getDashboardUrl());
                }}
                className="p-3 rounded-full bg-red-500 hover:bg-red-600 transition-colors"
                title="Leave call"
              >
                <Phone className="w-5 h-5 rotate-[135deg] text-white" />
              </button>

              {/* Divider */}
              <div className="w-px h-8 bg-zinc-700 mx-1" />

              {/* Layout Selector */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="p-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 transition-colors">
                    <LayoutList className="w-5 h-5 text-white" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="center"
                  className="bg-zinc-900 border-zinc-800 p-2 rounded-xl min-w-[180px]"
                  sideOffset={12}
                >
                  {layoutOptions.map((option) => (
                    <DropdownMenuItem
                      key={option.value}
                      onClick={() => setLayout(option.value as CallLayoutType)}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer",
                        layout === option.value
                          ? "bg-zinc-800 text-white"
                          : "text-zinc-400 hover:text-white hover:bg-zinc-800/50",
                      )}
                    >
                      <option.icon className="w-4 h-4" />
                      <span className="text-sm font-medium">
                        {option.label}
                      </span>
                      {layout === option.value && (
                        <div className="ml-auto w-2 h-2 rounded-full bg-white" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Incoming video quality — the bandwidth escape hatch, and the
                  single largest cost lever in the video subsystem. */}
              <IncomingVideoQualityMenu />

              {/* Stats Button */}
              <CallStatsButton />

              {/* Participants Toggle */}
              <button
                onClick={() => setShowParticipants((prev) => !prev)}
                className={cn(
                  "p-3 rounded-xl transition-colors relative",
                  showParticipants
                    ? "bg-white text-zinc-900"
                    : "bg-zinc-800 hover:bg-zinc-700 text-white",
                )}
              >
                <Users className="w-5 h-5" />
                {participantCount > 1 && (
                  <span className="absolute -top-1 -right-1 w-5 h-5 bg-white text-zinc-900 rounded-full text-xs font-medium flex items-center justify-center">
                    {participantCount}
                  </span>
                )}
              </button>

              {/* Divider */}
              <div className="w-px h-8 bg-zinc-700 mx-1" />

              {/* REC TIME Indicator for the host - Before End Call (only if recording enabled) */}
              {isHost && meetingSessionId && recordingEnabled && (
                <RecordingControls
                  meetingSessionId={meetingSessionId}
                  recordingEnabled={recordingEnabled}
                  showOnlyIndicator={true}
                />
              )}

              {/* Ending for EVERYONE lives behind this menu, and nowhere in
                  the bar itself. It used to be the widest, highest-contrast
                  element on the screen, sitting beside the ordinary hang-up —
                  two destructive actions a thumb's width apart, one of which
                  cannot be undone by the people it happens to. Reaching it now
                  takes a deliberate second step, and it still needs the
                  press-and-hold inside. */}
              {isHost && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="p-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 transition-colors"
                      title="Session options"
                    >
                      <MoreVertical className="w-5 h-5 text-white" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="w-72 bg-zinc-900 border-zinc-800 p-3 rounded-xl"
                    sideOffset={12}
                  >
                    <p className="text-sm font-medium text-white">
                      End for everyone
                    </p>
                    <p className="mt-1 mb-3 text-xs text-zinc-400">
                      Disconnects every participant and closes the room. Leaving
                      instead only removes you.
                    </p>
                    <EndCallButton />
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              {/* Recording Indicator for the guest - At the very end (only if recording enabled) */}
              {isGuest && meetingSessionId && recordingEnabled && (
                <RecordingControls
                  meetingSessionId={meetingSessionId}
                  recordingEnabled={recordingEnabled}
                  showOnlyIndicator={true}
                />
              )}
            </div>
          </div>
        </div>

        {/* Header. The title was the appointment type in caps repeated from
            the lobby; it now names the person, with the type demoted to the
            supporting line. The session clock sits opposite it, because until
            now nothing on this screen said how long was left. */}
        {/* Below the participants sidebar (z-40) and its backdrop (z-30): the
            header sits later in the DOM, so at equal stacking it painted over
            the panel's own heading and close control. */}
        <div className="pointer-events-none fixed inset-x-4 top-4 z-20 flex items-start justify-between gap-3">
          <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 backdrop-blur-sm">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-white">
                {sessionHeading(info)}
              </p>
              <p className="truncate text-xs text-zinc-500">
                {[
                  info.typeLabel,
                  `${participantCount} participant${participantCount !== 1 ? "s" : ""}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
          </div>

          <SessionClockPill startsAt={info.startsAt} endsAt={info.endsAt} />
        </div>

        {/* Connection notices sit under the header, out of the video's way,
            and only appear when there is something the person cannot otherwise
            explain — their own link degrading, or the server pausing incoming
            video to protect it. */}
        <div className="pointer-events-none fixed inset-x-4 top-20 z-20 flex justify-center">
          <ConnectionQualityNotice />
        </div>
      </section>
    </StreamVideoErrorBoundary>
  );
};

export default MeetingRoom;
