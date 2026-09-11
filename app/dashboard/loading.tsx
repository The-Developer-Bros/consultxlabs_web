import { PageSkeleton } from "@/components/dashboard/DashboardSkeletons";

// The last dashboard segment without a loading boundary. The index page is an
// instant server redirect today, but during the #1124 Netlify cold-boot stall
// even that redirect can take seconds — without this file the browser holds
// the previous screen (or flashes white) instead of painting chrome.
export default function Loading() {
  return <PageSkeleton />;
}
