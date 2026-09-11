import { notFound } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import StreamProvider from "@/providers/StreamProvider";

import { MessagesClient } from "./MessagesClient";

/**
 * Messages, scoped to this organization.
 *
 * ADR 19 splits dashboards by the org-ness of the underlying work, and chat was
 * the surface that never got split: it existed only in the personal trees, so a
 * member's org conversations either vanished or leaked into their B2C inbox
 * depending on which default the scope hook happened to resolve. This is the
 * org half.
 *
 * Access floors at active membership, exactly like Appointments — a LEARNER has
 * to be able to reach their own conversations. There is deliberately NO
 * `operations.read` variant of this page: an operator has no business reading
 * member conversations, and ADR 20 says so. Stream only ever returns channels
 * the viewer is a member of, so the floor is also the ceiling here.
 *
 * `enableChat` is true only on this route rather than on the org layout, so the
 * rest of the org tree keeps the video-only client it already had and no other
 * org page opens a chat websocket.
 */
export default async function OrgMessagesPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  const access = await requireOrgAccess(orgId);
  if (access.error) {
    notFound();
  }

  const userId = access.session.user.id;

  return (
    <>
      <DashboardHeader
        title="Messages"
        subtitle="Your conversations about this organization's sessions."
      />
      {/* Full-bleed: cancel the scaffold padding so the chat fills the column
          under the context bar, matching the personal Messages tabs. */}
      <div className="-mx-4 h-[calc(100dvh-3.5rem-4rem-var(--maintenance-banner-height,0px))] overflow-hidden border-border bg-card sm:-mx-6 md:h-[calc(100dvh-3.5rem-var(--maintenance-banner-height,0px))] lg:-mx-8">
        <StreamProvider userId={userId} enableChat={true} enableVideo={false}>
          <MessagesClient />
        </StreamProvider>
      </div>
    </>
  );
}
