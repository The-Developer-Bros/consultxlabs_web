/**
 * What a booking kind supports. Three detail pages each carried their own
 * `DOCUMENT_KINDS`, and the shared client rendered a Documents block for a
 * webinar anyway — fetching, failing, and then saying documents could be
 * uploaded once the booking was confirmed.
 */

import type { AppointmentVM } from "./view-model";

export type AppointmentKind = AppointmentVM["kind"];

/** Many attendees, one Payment each; the host reads money per seat. */
export function isGroupKind(kind: AppointmentKind): boolean {
  return kind === "WEBINAR" || kind === "CLASS";
}

/** Documents are a 1:1 exchange; a webinar or class has no reviewer pair. */
export function supportsDocuments(kind: AppointmentKind): boolean {
  return kind === "CONSULTATION" || kind === "SUBSCRIPTION" || kind === "TRIAL";
}
