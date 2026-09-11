"use client";

import { MessageSquareOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/DataCard";

/**
 * Fallback for chat surfaces when the Stream client fails to connect —
 * previously both dashboards rendered ChatLayout unconditionally, leaving
 * a blank fixed-height box on init failure. Shared by the consultant
 * Chats tab and the consultee Messages tab.
 */
export function ChatUnavailable({
  description,
  onRetry,
}: {
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={MessageSquareOff}
        title="Chat is unavailable"
        description={
          description ??
          "We couldn't connect to the messaging service. Check your connection and try again."
        }
        action={
          <Button
            variant="outline"
            onClick={onRetry ?? (() => window.location.reload())}
          >
            Retry
          </Button>
        }
      />
    </div>
  );
}
