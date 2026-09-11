import { redirect } from "next/navigation";

/**
 * The bare `/dashboard/org-workspace/<id>` URL had no page and 404'd, even
 * though every nav link and the role router point into `/home`. Anyone who
 * trimmed the last segment off the URL — or followed a link built by
 * concatenation without it — hit a dead end inside their own dashboard.
 *
 * The layout above has already run the IDOR guard, so by the time this
 * renders the id is known to be the caller's own.
 */
export default async function OrgWorkspaceIndexPage({
  params,
}: {
  params: Promise<{ orgWorkspaceId: string }>;
}) {
  const { orgWorkspaceId } = await params;
  redirect(`/dashboard/org-workspace/${orgWorkspaceId}/home`);
}
