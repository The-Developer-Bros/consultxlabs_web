"use client";

import { useEffect, useState } from "react";
import { format, isToday, isTomorrow } from "date-fns";
import { useCallStateHooks } from "@stream-io/video-react-sdk";
import { useSession } from "@/lib/auth-client";

/**
 * Reads the session a Stream call describes (#1070) into something the meeting
 * screens can render.
 *
 * Everything here is optional on purpose. Calls minted before the server
 * started stamping session data carry only a `title`, so each field falls back
 * rather than the screen going blank.
 */

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function date(value: unknown): Date | null {
  const raw = str(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * "CONSULTATION" → "Consultation". The type was being rendered raw and in caps,
 * which gave a database enum more visual weight than the person's name.
 */
function toTypeLabel(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  return raw
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export interface SessionInfo {
  /** The other side of this call, from the viewer's seat. */
  counterpartName: string | null;
  offeringTitle: string | null;
  /** Sentence case, never shouted. */
  typeLabel: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  durationMinutes: number | null;
  /** Whatever the call had before any of the above was stamped. */
  fallbackTitle: string;
  isHost: boolean;
}

/** The session as seen from the current viewer's seat. */
export function useSessionInfo(): SessionInfo {
  const { useCallCustomData } = useCallStateHooks();
  const custom = useCallCustomData();
  const { data: session } = useSession();

  const consultantUserId = str(custom?.consultantUserId);
  // #org-appts — which SIDE of this appointment the viewer is on, not the
  // singular UserRole, which is wrong for a dual-profile user booked as a
  // learner into someone else's session. Role fallback for legacy calls
  // created before the stamp. THE definition: MeetingRoom and EndCallButton
  // read `isHost` off this hook rather than repeating it, because it gates
  // "End for everyone" — a destructive action the people it affects cannot
  // undo, and three copies could disagree about who may take it.
  const isHost = consultantUserId
    ? session?.user?.id === consultantUserId
    : session?.user?.role === "CONSULTANT";

  const hostName = str(custom?.hostName);
  const guestName = str(custom?.guestName);

  const startsAt = date(custom?.sessionStartsAt);
  const endsAt = date(custom?.sessionEndsAt);
  const stampedDuration =
    typeof custom?.sessionDurationMinutes === "number"
      ? custom.sessionDurationMinutes
      : null;

  return {
    counterpartName: isHost ? guestName : hostName,
    offeringTitle: str(custom?.offeringTitle),
    typeLabel: toTypeLabel(custom?.appointmentType),
    startsAt,
    endsAt,
    durationMinutes:
      stampedDuration ??
      (startsAt && endsAt
        ? Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000)
        : null),
    fallbackTitle: str(custom?.title) ?? "Meeting",
    isHost,
  };
}

/**
 * The heading a screen should lead with: the person if we know them, then the
 * offering, and only then whatever the call called itself.
 */
export function sessionHeading(info: SessionInfo): string {
  return info.counterpartName ?? info.offeringTitle ?? info.fallbackTitle;
}

/**
 * The supporting line under the heading — the offering, unless it is already
 * doing duty as the heading.
 */
export function sessionSubheading(info: SessionInfo): string | null {
  if (!info.counterpartName) return null;
  return info.offeringTitle;
}

/** "Today at 3:00 PM", "Tomorrow at 9:30 AM", "Fri 8 Aug at 11:00 AM". */
export function formatScheduledAt(startsAt: Date | null): string | null {
  if (!startsAt) return null;
  const time = format(startsAt, "h:mm a");
  if (isToday(startsAt)) return `Today at ${time}`;
  if (isTomorrow(startsAt)) return `Tomorrow at ${time}`;
  return `${format(startsAt, "EEE d MMM")} at ${time}`;
}

export type SessionPhase =
  | "unknown"
  | "early"
  | "starting-soon"
  | "in-progress"
  | "overrunning";

export interface SessionClock {
  phase: SessionPhase;
  /**
   * The one line worth leading with: "Starts in 6 min", "1 hr 19 min left",
   * "12 min over". In a booked session what remains is what a consultant acts
   * on — whether to wrap up, whether there is room for one more topic —
   * so this is the pill's headline and elapsed time is context beneath it.
   */
  status: string | null;
  /** Time on the clock since the session started, "MM:SS" or "H:MM:SS". */
  elapsed: string | null;
  /**
   * `elapsed` with the word that says what it is. The in-call pill showed a
   * bare "2:41:12" beside a labelled "1 hr 19 min left", and two unexplained
   * durations side by side read as contradicting each other.
   */
  elapsedLabel: string | null;
  /** "48 min left" against the BOOKED end, null once past it. */
  remaining: string | null;
}

/** The lobby calls a session "starting soon" inside this window. */
const STARTING_SOON_MS = 10 * 60 * 1000;

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

function minutesLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

export function readClock(
  startsAt: Date | null,
  endsAt: Date | null,
  now: Date,
): SessionClock {
  if (!startsAt) {
    return {
      phase: "unknown",
      status: null,
      elapsed: null,
      elapsedLabel: null,
      remaining: null,
    };
  }

  const sinceStart = now.getTime() - startsAt.getTime();
  const untilEnd = endsAt ? endsAt.getTime() - now.getTime() : null;

  if (sinceStart < 0) {
    const untilStart = -sinceStart;
    return {
      phase: untilStart <= STARTING_SOON_MS ? "starting-soon" : "early",
      status: `Starts in ${minutesLabel(untilStart)}`,
      elapsed: null,
      elapsedLabel: null,
      remaining: null,
    };
  }

  const elapsed = formatClock(sinceStart);

  // Past the booked end but still connected: say so rather than counting into
  // negative numbers. The call is not cut off — nothing here ends it (#1070).
  if (untilEnd !== null && untilEnd <= 0) {
    return {
      phase: "overrunning",
      status: `${minutesLabel(-untilEnd)} over`,
      elapsed,
      elapsedLabel: `${elapsed} elapsed`,
      remaining: null,
    };
  }

  const remaining = untilEnd === null ? null : `${minutesLabel(untilEnd)} left`;
  return {
    phase: "in-progress",
    status: remaining ?? "In progress",
    elapsed,
    elapsedLabel: `${elapsed} elapsed`,
    remaining,
  };
}

/**
 * A ticking read of where we are in the booked session. One second, because
 * the in-call screen shows seconds; the lobby only reads minutes off it.
 */
export function useSessionClock(
  startsAt: Date | null,
  endsAt: Date | null,
): SessionClock {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return readClock(startsAt, endsAt, now);
}
