import { Skeleton } from "@/components/ui/skeleton";

/** Explore plan detail: image hero + 2/1 content + sticky sidebar. */
export function PlanDetailSkeleton() {
  return (
    <main className="min-h-screen bg-muted">
      <div className="relative h-[350px] w-full overflow-hidden bg-zinc-900 md:h-[400px]">
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 space-y-3 p-6 md:p-10">
          <Skeleton className="h-6 w-24 rounded-full bg-zinc-700" />
          <Skeleton className="h-10 w-full max-w-xl bg-zinc-700" />
          <Skeleton className="h-4 w-64 bg-zinc-700" />
        </div>
      </div>
      <div className="mx-auto grid max-w-[92%] gap-8 py-8 lg:grid-cols-3 lg:py-12">
        <div className="space-y-6 lg:col-span-2">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-8 w-48" />
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/6" />
          </div>
          <Skeleton className="h-48 rounded-xl" />
        </div>
        <div className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    </main>
  );
}
