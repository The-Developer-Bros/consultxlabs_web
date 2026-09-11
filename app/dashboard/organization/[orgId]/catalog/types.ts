/** Shared shapes for the org catalog surface. */

export type Kind = "WEBINAR" | "CLASS";

/** Row as the API returns it — `price` is a paise string (BigInt on the wire). */
export interface CatalogRow {
  id: string;
  title: string;
  price: string;
  visibility: "PUBLIC" | "ORG_ONLY" | "ORG_AND_PUBLIC";
  maxParticipants: number;
  consultantProfileId: string | null;
  archivedAt: string | null;
}

export interface CatalogResponse {
  webinars: CatalogRow[];
  classes: CatalogRow[];
}
