"use client";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import {
  CallingState,
  useCall,
  useCallStateHooks,
  VideoPreview,
} from "@stream-io/video-react-sdk";
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  Settings,
  Loader2,
  Volume2,
  CalendarClock,
  Timer,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/utils/tailwind";
import {
  createMicLevelMeter,
  SPEAKING_THRESHOLD,
} from "@/lib/stream/audio-level";
import {
  formatScheduledAt,
  sessionHeading,
  sessionSubheading,
  useSessionClock,
  useSessionInfo,
} from "../session-info";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExitMeetingButton } from "./ExitMeetingButton";
import { useRecordingConsent } from "./RecordingConsentNotice";

interface MeetingSetupProps {
  setIsSetupComplete: (value: boolean) => void;
  /** Stream call id, so the lobby can fetch this session's recording notice. */
  meetingId: string;
}

const DeviceSelector = () => {
  const { useMicrophoneState, useCameraState, useSpeakerState } =
    useCallStateHooks();
  const micState = useMicrophoneState();
  const camState = useCameraState();
  const speakerState = useSpeakerState?.();

  const [selectedMic, setSelectedMic] = useState<string>("");
  const [selectedCam, setSelectedCam] = useState<string>("");
  const [selectedSpeaker, setSelectedSpeaker] = useState<string>("");

  useEffect(() => {
    if (micState.selectedDevice) setSelectedMic(micState.selectedDevice);
  }, [micState.selectedDevice]);

  useEffect(() => {
    if (camState.selectedDevice) setSelectedCam(camState.selectedDevice);
  }, [camState.selectedDevice]);

  useEffect(() => {
    if (speakerState?.selectedDevice)
      setSelectedSpeaker(speakerState.selectedDevice);
  }, [speakerState?.selectedDevice]);

  return (
    <div className="space-y-4">
      {/* Camera */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Video className="w-4 h-4" />
          <Label className="text-sm font-medium">Camera</Label>
        </div>
        <Select
          value={selectedCam}
          onValueChange={async (val) => {
            setSelectedCam(val);
            await camState.camera.select(val);
          }}
        >
          <SelectTrigger className="bg-card border-border">
            <SelectValue placeholder="Select Camera" />
          </SelectTrigger>
          <SelectContent>
            {camState.devices?.map((d) => (
              <SelectItem key={d.deviceId} value={d.deviceId}>
                {d.label || `Camera ${d.deviceId}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Microphone */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Mic className="w-4 h-4" />
          <Label className="text-sm font-medium">Microphone</Label>
        </div>
        <Select
          value={selectedMic}
          onValueChange={async (val) => {
            setSelectedMic(val);
            await micState.microphone.select(val);
          }}
        >
          <SelectTrigger className="bg-card border-border">
            <SelectValue placeholder="Select Microphone" />
          </SelectTrigger>
          <SelectContent>
            {micState.devices?.map((d) => (
              <SelectItem key={d.deviceId} value={d.deviceId}>
                {d.label || `Microphone ${d.deviceId}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Speakers */}
      {speakerState?.devices && speakerState.devices.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Volume2 className="w-4 h-4" />
            <Label className="text-sm font-medium">Speakers</Label>
          </div>
          <Select
            value={selectedSpeaker}
            onValueChange={async (val) => {
              setSelectedSpeaker(val);
              await speakerState.speaker.select(val);
            }}
          >
            <SelectTrigger className="bg-card border-border">
              <SelectValue placeholder="Select Speakers" />
            </SelectTrigger>
            <SelectContent>
              {speakerState.devices.map((d) => (
                <SelectItem key={d.deviceId} value={d.deviceId}>
                  {d.label || `Speaker ${d.deviceId}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
};

const MeetingSetup = ({ setIsSetupComplete, meetingId }: MeetingSetupProps) => {
  const call = useCall();
  const { useMicrophoneState, useCameraState } = useCallStateHooks();
  const micState = useMicrophoneState();
  const camState = useCameraState();

  // Device state is read from the SDK rather than mirrored into local booleans,
  // which could disagree with the hardware after a failed toggle.
  const isMicOn = micState.isEnabled;
  const isCameraOn = camState.isEnabled;
  const micStream = micState.mediaStream;

  // The bar is driven through a ref rather than state: at one setState per
  // animation frame React re-rendered the whole lobby ~60x/second, and the
  // bar's own CSS transition then fought the updates. Only the caption, which
  // changes rarely, is state.
  const micBarRef = useRef<HTMLDivElement | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // #1134 P1-7 — nobody reaches the call before seeing the recording notice.
  const consent = useRecordingConsent(meetingId);

  const info = useSessionInfo();
  const clock = useSessionClock(info.startsAt, info.endsAt);
  const scheduledAt = formatScheduledAt(info.startsAt);
  const heading = sessionHeading(info);
  const subheading = sessionSubheading(info);

  const initDevices = useCallback(async () => {
    try {
      await camState.camera.disable();
      await micState.microphone.enable();
    } catch (error) {
      console.error("Error initializing devices:", error);
    }
  }, [camState.camera, micState.microphone]);

  useEffect(() => {
    if (call) {
      initDevices();
    }
  }, [call, initDevices]);

  useEffect(() => {
    setIsSpeaking(false);
    if (micBarRef.current) micBarRef.current.style.width = "0%";
    if (!isMicOn || !micStream) return;

    // The stream is Stream's own (`useMicrophoneState().mediaStream`), so the
    // meter observes it and never owns it — see lib/stream/audio-level.
    return createMicLevelMeter(micStream, (level) => {
      if (micBarRef.current) {
        micBarRef.current.style.width = `${Math.max(level * 100, 2)}%`;
      }
      setIsSpeaking(level >= SPEAKING_THRESHOLD);
    });
  }, [isMicOn, micStream]);

  const handleJoinMeeting = async () => {
    try {
      setIsJoining(true);
      if (call) {
        switch (call.state.callingState) {
          case CallingState.JOINED:
            toast({
              title: "Already joined meeting",
              description: "You are already connected to this meeting.",
            });
            setIsSetupComplete(true);
            return;

          case CallingState.JOINING:
            toast({
              title: "Joining in progress",
              description: "Please wait while we connect you to the meeting.",
            });
            return;

          case CallingState.RECONNECTING:
            toast({
              title: "Reconnecting to meeting",
              description: "Please wait while we reconnect you to the meeting.",
            });
            return;

          case CallingState.IDLE:
            await call.join();
            setIsSetupComplete(true);
            return;

          default:
            await call.join();
            setIsSetupComplete(true);
            return;
        }
      }
    } catch (error) {
      console.error("Error joining meeting:", error);
      toast({
        title: "Failed to join meeting",
        description:
          "There was an error joining the meeting. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsJoining(false);
    }
  };

  const toggleCamera = async () => {
    try {
      await camState.camera.toggle();
    } catch (error) {
      console.error("Error toggling camera:", error);
    }
  };

  const toggleMic = async () => {
    try {
      await micState.microphone.toggle();
    } catch (error) {
      console.error("Error toggling microphone:", error);
    }
  };

  const joinLabel = consent.loading
    ? // The button is disabled for as long as this fetch is out. Without a
      // label for it the control just looks broken, and the notice it is
      // waiting on has not rendered yet to explain itself.
      "Checking recording notice..."
    : clock.phase === "in-progress" || clock.phase === "overrunning"
      ? "Join now"
      : clock.phase === "early"
        ? "Join early"
        : "Join meeting";

  /** Mic and camera toggles, kept beside the preview so a change is seen. */
  const deviceToggles = (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={toggleMic}
        aria-label={isMicOn ? "Turn microphone off" : "Turn microphone on"}
        aria-pressed={isMicOn}
        className={cn(
          "w-12 h-12 rounded-full flex items-center justify-center transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900",
          isMicOn
            ? "bg-white/10 text-white hover:bg-white/20"
            : "bg-red-500 text-white hover:bg-red-600",
        )}
      >
        {isMicOn ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
      </button>

      <button
        type="button"
        onClick={toggleCamera}
        aria-label={isCameraOn ? "Turn camera off" : "Turn camera on"}
        aria-pressed={isCameraOn}
        className={cn(
          "w-12 h-12 rounded-full flex items-center justify-center transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900",
          isCameraOn
            ? "bg-white/10 text-white hover:bg-white/20"
            : "bg-red-500 text-white hover:bg-red-600",
        )}
      >
        {isCameraOn ? (
          <Video className="w-5 h-5" />
        ) : (
          <VideoOff className="w-5 h-5" />
        )}
      </button>

      <button
        type="button"
        onClick={() => setShowSettings(true)}
        aria-label="Audio and video settings"
        aria-haspopup="dialog"
        className={cn(
          "w-12 h-12 rounded-full flex items-center justify-center transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900",
          "bg-white/10 text-white hover:bg-white/20",
        )}
      >
        <Settings className="w-5 h-5" />
      </button>
    </div>
  );

  return (
    <div className="relative min-h-screen bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-900 px-4 py-6 sm:px-6 lg:px-8">
      {/* Background pattern */}
      <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiMyMjIiIGZpbGwtb3BhY2l0eT0iMC4wNSI+PGNpcmNsZSBjeD0iMzAiIGN5PSIzMCIgcj0iMiIvPjwvZz48L2c+PC9zdmc+')] opacity-50" />

      <div className="relative z-10 mx-auto w-full max-w-6xl">
        {/* #1067 — the route had no exit but the browser Back button. */}
        <ExitMeetingButton className="-ml-3" />
      </div>

      <div className="relative z-10 mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-6xl items-center">
        {/*
          The preview used to sit in a narrow max-w-lg column, so it was small
          and cropped. It is now the subject: a full-width 16:9 frame in the
          wide column, with the session details and Join beside it on a desktop
          and stacked beneath it on anything narrower.
        */}
        <div className="grid w-full gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-8 lg:items-center">
          {/* Preview + the controls that change it */}
          <div className="space-y-4">
            <div className="meeting-lobby-preview relative aspect-video w-full overflow-hidden rounded-2xl bg-zinc-950 shadow-2xl ring-1 ring-white/10">
              <VideoPreview mirror={true} />
              {!isCameraOn && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-950">
                  <div className="mb-3 flex h-20 w-20 items-center justify-center rounded-full bg-zinc-800">
                    <VideoOff className="h-8 w-8 text-zinc-500" />
                  </div>
                  <p className="text-sm font-medium text-zinc-400">
                    Camera is off
                  </p>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4">
              {deviceToggles}

              {/* The on/off chips that used to sit here are gone: the toggles
                  are now beside the preview and go red when off, and the
                  preview says so itself, so the chips only repeated them. */}
              {isMicOn && (
                <div className="min-w-0 flex-1 sm:max-w-xs">
                  <div className="flex items-center gap-3">
                    <Mic className="h-4 w-4 shrink-0 text-zinc-500" />
                    <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
                      <div
                        ref={micBarRef}
                        className="h-full rounded-full bg-white"
                        style={{ width: "0%" }}
                      />
                    </div>
                  </div>
                  <p className="mt-1.5 pl-7 text-xs text-zinc-400">
                    {isSpeaking
                      ? "We can hear you"
                      : "Say something to check your microphone"}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Session details + the primary action */}
          <div className="rounded-2xl border border-border/50 bg-card/95 p-6 shadow-2xl backdrop-blur-xl">
            {/* Header — the person first, the offering under it, and the type
                as a quiet chip. It was an upper-cased enum in the largest type
                on the screen, above the name of the person you are meeting. */}
            <div className="flex flex-wrap items-center gap-2">
              {info.typeLabel && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {info.typeLabel}
                </span>
              )}
              {clock.status && (
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs font-medium",
                    clock.phase === "in-progress" ||
                      clock.phase === "overrunning"
                      ? "bg-green-500/15 text-green-500"
                      : clock.phase === "starting-soon"
                        ? "bg-foreground text-background"
                        : "bg-muted text-muted-foreground",
                  )}
                >
                  {clock.phase === "in-progress" ||
                  clock.phase === "overrunning"
                    ? "In progress"
                    : clock.status}
                </span>
              )}
            </div>

            <h1 className="mt-2 truncate text-fluid-2xl font-semibold tracking-tight text-foreground">
              {heading}
            </h1>
            {subheading && (
              <p className="truncate text-sm text-muted-foreground">
                {subheading}
              </p>
            )}

            {(scheduledAt || (info.durationMinutes ?? 0) > 0) && (
              <div className="mt-4 space-y-1.5 text-sm text-muted-foreground">
                {scheduledAt && (
                  <span className="flex items-center gap-1.5">
                    <CalendarClock className="h-4 w-4 shrink-0" />
                    {scheduledAt}
                  </span>
                )}
                {(info.durationMinutes ?? 0) > 0 && (
                  <span className="flex items-center gap-1.5">
                    <Timer className="h-4 w-4 shrink-0" />
                    {info.durationMinutes} min
                  </span>
                )}
              </div>
            )}

            {consent.node && <div className="mt-4">{consent.node}</div>}

            <Button
              onClick={handleJoinMeeting}
              disabled={isJoining || !consent.satisfied}
              className="mt-6 h-12 w-full rounded-xl bg-primary text-base font-semibold text-primary-foreground shadow-lg transition-colors hover:bg-primary/90 disabled:opacity-70"
            >
              {isJoining ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Joining...
                </>
              ) : (
                joinLabel
              )}
            </Button>

            {/* Replaces "Tip: test your mic and camera before joining", which
                restated the screen. This only appears when there is something
                the person would otherwise be surprised by. */}
            {(!micState.hasBrowserPermission || !isCameraOn) && (
              <p className="mt-3 text-center text-xs text-muted-foreground">
                {!micState.hasBrowserPermission
                  ? "Your browser is blocking the microphone. Allow access to be heard."
                  : "Your camera is off — you will join with audio only."}
              </p>
            )}
          </div>
        </div>
      </div>

      {/*
        Was an inline block under the controls, so on a short viewport the
        device lists ran off the bottom of the page and the lower options were
        unreachable. DialogContent is portalled, caps itself at 90dvh and
        scrolls internally, and brings Esc/outside-click/focus-trap with it.
      */}
      <Dialog open={showSettings} onOpenChange={setShowSettings}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Audio &amp; video settings</DialogTitle>
          </DialogHeader>
          <DeviceSelector />
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default MeetingSetup;
