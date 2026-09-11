import { ChatSkeleton } from "@/components/dashboard/DashboardSkeletons";

/**
 * Was a bespoke copy with its own `h-[calc(100vh-theme(spacing.16))]` and a
 * `w-1/4` sidebar — a second implementation of the consultee one that drifted
 * from both it and the real chat layout. Same surface, same skeleton.
 */
export default function MessagesLoading() {
  return <ChatSkeleton />;
}
