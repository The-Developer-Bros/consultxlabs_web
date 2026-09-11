import { Skeleton } from "@/components/ui/skeleton";

/** Org invite accept card — matches InviteAcceptPage chrome. */
export function InviteAcceptSkeleton() {
  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-md items-center justify-center p-6">
      <div className="w-full space-y-4 rounded-xl border border-border bg-card p-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-12 w-12 rounded-xl" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-28" />
          </div>
        </div>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-11 w-full rounded-lg" />
        <Skeleton className="h-11 w-full rounded-lg" />
      </div>
    </main>
  );
}
