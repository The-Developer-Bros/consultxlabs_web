import { Skeleton } from "@/components/ui/skeleton";

/** Explore plan detail: dark title band + facts grid + content column + sidebar. */
export function PlanDetailSkeleton() {
  return (
    <main className="min-h-screen bg-background">
      <section className="bg-zinc-950">
        <div className="mx-auto flex min-h-[380px] max-w-[1600px] flex-col px-4 md:min-h-[440px] md:px-8 lg:px-12">
          <div className="pt-6 md:pt-8">
            <Skeleton className="h-4 w-28 bg-zinc-800" />
          </div>
          <div className="mt-auto space-y-4 pb-10 pt-10 md:pb-14 md:pt-16">
            <div className="flex gap-2">
              <Skeleton className="h-6 w-16 rounded-full bg-zinc-800" />
              <Skeleton className="h-6 w-20 rounded-full bg-zinc-800" />
            </div>
            <Skeleton className="h-10 w-full max-w-2xl bg-zinc-800" />
            <Skeleton className="h-5 w-full max-w-lg bg-zinc-800" />
            <Skeleton className="h-8 w-44 bg-zinc-800" />
          </div>
        </div>
      </section>

      <div className="mx-auto grid max-w-[1600px] gap-8 px-4 py-10 md:px-8 md:py-14 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-12 lg:px-12">
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-20 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-48 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
        <div className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <Skeleton className="h-56 rounded-2xl" />
          <Skeleton className="h-48 rounded-2xl" />
        </div>
      </div>
    </main>
  );
}
