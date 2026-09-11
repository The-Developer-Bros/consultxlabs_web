import type { SlotOfAppointment } from "@prisma/client";

export const DEFAULT_MEETING_DURATION_MS = 60 * 60 * 1000;

export interface SlotWithMeetingSession extends SlotOfAppointment {
  meetingSession?: {
    id: string;
    endedAt: Date | string | null;
    /** #1270 — required; see the note in lib/appointments/slots.ts. */
    endedReason: string | null;
  } | null;
}

export type SessionStatus = "completed" | "noRecord" | "upcoming" | "joinable";
