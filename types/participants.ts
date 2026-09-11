/**
 * Shared types for Participant API responses.
 * Used by consultant participant pages (consultation, subscription, webinar, class).
 */

/** User info in participant lists — shared by consultation + subscription participant pages. */
export interface ParticipantUser {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
}
