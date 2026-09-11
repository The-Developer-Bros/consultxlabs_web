import { Skeleton } from "@/components/ui/skeleton";

/** Landing first-viewport: dark hero matching HeroSection. */
export function LandingHeroSkeleton() {
  return (
    <main className="flex-1 w-full min-h-screen overflow-hidden bg-black">
      <section className="relative flex min-h-[95vh] items-center overflow-hidden">
        <div className="pointer-events-none absolute inset-0 opacity-30 [background-image:linear-gradient(to_right,rgba(255,255,255,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.06)_1px,transparent_1px)] [background-size:48px_48px]" />
        <div className="container relative z-10 mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-4xl space-y-6 text-center">
            <Skeleton className="mx-auto h-7 w-36 rounded-full bg-zinc-800" />
            <Skeleton className="mx-auto h-14 w-full max-w-2xl bg-zinc-800 sm:h-16" />
            <Skeleton className="mx-auto h-5 w-full max-w-xl bg-zinc-800" />
            <div className="flex flex-wrap items-center justify-center gap-4 pt-2">
              <Skeleton className="h-12 w-40 rounded-xl bg-zinc-800" />
              <Skeleton className="h-12 w-40 rounded-xl bg-zinc-800" />
            </div>
            <div className="mx-auto grid max-w-2xl grid-cols-2 gap-4 pt-8 md:grid-cols-4">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="mx-auto h-8 w-16 bg-zinc-800" />
                  <Skeleton className="mx-auto h-3 w-20 bg-zinc-800" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
