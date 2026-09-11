"use client";

import { useCallback, useMemo, useState } from "react";
import { cn } from "@/utils/tailwind";
import { ChatSidebar } from "./ChatSidebar";
import { ChatContainer } from "./ChatContainer";
import { ChatPaneProvider } from "./ChatPaneContext";

/**
 * Two panes side by side from `md` up; one pane at a time below it (#1134).
 *
 * The sidebar used to render an unconditional 320px column beside the
 * conversation with no breakpoint logic at all, which left 55px of
 * conversation on a 375px phone — chat was unusable on mobile, not merely
 * cramped. This mirrors `ChatSkeleton`, which already collapsed its list
 * correctly, and the list/detail swap `MeetingRoom` uses for its participant
 * panel.
 */
export const ChatLayout = () => {
  const [conversationOpen, setConversationOpen] = useState(false);

  const openConversation = useCallback(() => setConversationOpen(true), []);
  const backToList = useCallback(() => setConversationOpen(false), []);

  const pane = useMemo(
    () => ({ conversationOpen, openConversation, backToList }),
    [conversationOpen, openConversation, backToList],
  );

  return (
    <ChatPaneProvider value={pane}>
      <div className="flex h-full w-full">
        <div
          className={cn(
            "h-full w-full shrink-0 md:block md:w-80",
            conversationOpen && "hidden",
          )}
        >
          <ChatSidebar />
        </div>
        {/* Hidden rather than unmounted below `md`: unmounting would tear down
            the watched Stream channel and reload its history on every back. */}
        <div
          className={cn(
            "h-full flex-1 flex-col md:flex",
            conversationOpen ? "flex" : "hidden",
          )}
        >
          <ChatContainer />
        </div>
      </div>
    </ChatPaneProvider>
  );
};
