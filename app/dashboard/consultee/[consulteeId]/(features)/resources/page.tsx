import { redirect } from "next/navigation";

/**
 * Retired. Resources split into Documents and Recordings — "where is the
 * recording" and "where is the handout" are different errands, and one page
 * tabbed by event type answered neither directly.
 *
 * Kept as a redirect so existing links and bookmarks still land somewhere
 * sensible rather than 404ing.
 */
export default async function ConsulteeResourcesRedirect({
  params,
}: {
  params: Promise<{ consulteeId: string }>;
}) {
  const { consulteeId } = await params;
  redirect(`/dashboard/consultee/${consulteeId}/documents`);
}
