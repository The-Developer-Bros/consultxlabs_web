"use client";

import { ChatLayout } from "@/components/chat/ChatLayout";
import { ChatUnavailable } from "@/components/chat/ChatUnavailable";
import { ChatSkeletonPanes } from "@/components/dashboard/DashboardSkeletons";
import { useStreamConnection } from "@/providers/StreamProvider";
import { StreamChatScope } from "@/components/stream/StreamChatScope";

/**
 * Full-bleed chat surface: cancels PageScaffold padding and fills the
 * content column under the context bar (and above the mobile tab bar).
 *
 * Takes no props: the page above used to run a whole consultant-details query
 * to feed a `userId`/`userRole` pair this component immediately discarded.
 */
export function MessagesTab() {
  // Connection state from the lazy Stream provider: render the chat UI only
  // once the chat client is live; surface failures instead of a blank box.
  const { chatConnected, error, retryConnection } = useStreamConnection();

  return (
    <div className="-m-4 h-[calc(100dvh-3.5rem-4rem-var(--maintenance-banner-height,0px))] overflow-hidden border-border bg-card sm:-m-6 md:h-[calc(100dvh-3.5rem-var(--maintenance-banner-height,0px))] lg:-m-8">
      {error ? (
        <ChatUnavailable description={error} onRetry={retryConnection} />
      ) : chatConnected ? (
        <StreamChatScope>
          <ChatLayout />
        </StreamChatScope>
      ) : (
        // The chat skeleton, so connecting looks like the surface that is
        // about to arrive rather than a bare centred spinner. Three of these
        // spinners existed, all slightly different.
        <ChatSkeletonPanes />
      )}
    </div>
  );
}
