import { Skeleton } from "@/components/ui/skeleton";

/** Marketing / use-case pages: hero + section spine (not a card grid). */
export function MarketingPageSkeleton() {
  return (
    <main className="min-h-screen bg-background">
      <section className="relative overflow-hidden bg-zinc-950 px-4 pb-16 pt-28 md:px-6 md:pb-24 md:pt-32">
        <div className="mx-auto max-w-4xl space-y-5 text-center">
          <Skeleton className="mx-auto h-6 w-28 rounded-full bg-zinc-800" />
          <Skeleton className="mx-auto h-12 w-full max-w-2xl bg-zinc-800" />
          <Skeleton className="mx-auto h-5 w-full max-w-xl bg-zinc-800" />
          <div className="flex justify-center gap-3 pt-2">
            <Skeleton className="h-11 w-36 rounded-xl bg-zinc-800" />
            <Skeleton className="h-11 w-36 rounded-xl bg-zinc-800" />
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-5xl space-y-10 px-4 py-16 md:px-6">
        <div className="space-y-3">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-full max-w-2xl" />
          <Skeleton className="h-4 w-full max-w-xl" />
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <Skeleton className="h-56 rounded-2xl" />
          <Skeleton className="h-56 rounded-2xl" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-4/6" />
        </div>
      </section>
    </main>
  );
}
