import { Skeleton } from "@/components/ui/skeleton";

/**
 * Content-only fallback. This segment's layout already mounts
 * `OrgWorkspaceShell`, and `loading.tsx` renders as that shell's
 * `children` — a full-page `CollapsibleSidebarSkeleton` here would nest a
 * second viewport + sidebar inside the scrollable main.
 *
 * No outer padding: the shell's `<main>` already wraps children in `p-6`.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <Skeleton key={i} className="h-32 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
