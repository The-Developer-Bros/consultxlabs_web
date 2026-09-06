import { Skeleton } from "@/components/ui/skeleton";

/** Explore programs list: dark hero + toolbar + curated rows + results grid. */
export function ProgramsExploreSkeleton() {
  return (
    <main className="min-h-screen bg-background">
      <section className="border-b border-white/10 bg-zinc-950 px-4 pb-16 pt-32 md:px-8 md:pb-20 md:pt-40 lg:px-12">
        <div className="mx-auto max-w-[1600px]">
          <div className="max-w-3xl">
            <Skeleton className="h-3 w-24 bg-zinc-800" />
            <Skeleton className="mt-5 h-11 w-full max-w-xl bg-zinc-800" />
            <Skeleton className="mt-3 h-11 w-full max-w-md bg-zinc-800" />
            <Skeleton className="mt-6 h-5 w-full max-w-lg bg-zinc-800" />
            <div className="mt-10 flex flex-wrap gap-x-10 gap-y-6">
              {[1, 2, 3].map((i) => (
                <div key={i}>
                  <Skeleton className="h-8 w-16 bg-zinc-800" />
                  <Skeleton className="mt-1.5 h-3 w-24 bg-zinc-800" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1600px] px-4 py-10 md:px-8 md:py-16 lg:px-12">
        {/* Toolbar */}
        <Skeleton className="mb-10 h-12 w-64 rounded-xl" />

        {/* Featured */}
        <div className="mb-14 space-y-6">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-[280px] w-full rounded-2xl" />
        </div>

        {/* Two curated rows */}
        {[1, 2].map((row) => (
          <div key={row} className="mb-14 space-y-6">
            <Skeleton className="h-7 w-44" />
            <div className="flex gap-4 overflow-hidden">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton
                  key={i}
                  className="h-[300px] w-[320px] shrink-0 rounded-2xl md:w-[360px]"
                />
              ))}
            </div>
          </div>
        ))}

        {/* Topic tiles */}
        <div className="mb-14 space-y-6">
          <Skeleton className="h-7 w-48" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
              <Skeleton key={i} className="h-[74px] rounded-2xl" />
            ))}
          </div>
        </div>

        {/* Results */}
        <div className="space-y-6">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-[92px] w-full rounded-2xl" />
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
              <Skeleton key={i} className="h-72 rounded-2xl" />
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
