import { Skeleton } from "@/components/ui/skeleton";

/** Explore organisations directory: dark hero + filter/grid shell. */
export function OrganisationsExploreSkeleton() {
  return (
    <main className="min-h-screen bg-background">
      <section className="bg-zinc-950 px-4 pb-16 pt-32 md:px-6">
        <div className="mx-auto max-w-[1400px] space-y-5">
          <Skeleton className="h-6 w-28 rounded-full bg-zinc-800" />
          <Skeleton className="h-12 w-full max-w-lg bg-zinc-800" />
          <Skeleton className="h-5 w-full max-w-md bg-zinc-800" />
        </div>
      </section>
      <section className="mx-auto max-w-[1400px] px-4 py-10 md:px-6">
        <div className="grid gap-8 lg:grid-cols-[260px_1fr]">
          <div className="hidden space-y-4 lg:block">
            <Skeleton className="h-10 w-full" />
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
              <Skeleton key={i} className="h-52 rounded-xl" />
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
