/**
 * Shape of a recording row as the API returns it.
 *
 * Lives here rather than beside the card that renders it because `lib/` needs
 * it too, and `lib/` importing a type out of a route folder — through a
 * `[consultantId]` dynamic segment — inverts the dependency direction: `app/`
 * is the routing layer and should depend on `lib`, `components` and `hooks`,
 * never the reverse. Nothing re-exports it — the card imports it from here like
 * every other consumer, so there is one definition and one import path.
 */
export interface RecordingData {
  id: string;
  title: string;
  durationInMinutes: number;
  recordedAt: string;
  status: string;
  storageType: string;
  playbackUrl: string | null;
  thumbnailUrl: string | null;
  resolution: string | null;
  fileSize: number | null;
  streamUrlExpiresAt: string | null;
  transferredAt: string | null;
  planType: "webinar" | "class" | null;
  planId: string | null;
  planTitle: string | null;
  participantNames: string[];
  participantCount: number;
  appointmentDate: string | null;
  createdAt: string;
}
