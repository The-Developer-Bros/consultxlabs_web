import { Skeleton } from "@/components/ui/skeleton";

/** Landing first-viewport: dark hero matching HeroSection. */
export function LandingHeroSkeleton() {
  return (
    <main className="w-full flex-1 overflow-hidden bg-zinc-950">
      <section className="relative flex min-h-[88svh] items-center border-b border-white/10">
        <div className="container relative z-10 mx-auto px-4 py-24 md:px-6 md:py-32">
          <div className="mx-auto max-w-4xl text-center">
            <Skeleton className="mx-auto h-4 w-72 bg-white/[0.06]" />
            <Skeleton className="mx-auto mt-8 h-12 w-full max-w-2xl bg-white/[0.06] sm:h-14" />
            <Skeleton className="mx-auto mt-3 h-12 w-full max-w-xl bg-white/[0.06] sm:h-14" />
            <Skeleton className="mx-auto mt-6 h-5 w-full max-w-xl bg-white/[0.06]" />
            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Skeleton className="h-12 w-44 rounded-xl bg-white/[0.06]" />
              <Skeleton className="h-12 w-44 rounded-xl bg-white/[0.06]" />
            </div>
            <div className="mt-16 grid grid-cols-3 divide-x divide-white/10 border-t border-white/10 pt-10">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex flex-col items-center px-2">
                  <Skeleton className="h-9 w-20 bg-white/[0.06]" />
                  <Skeleton className="mt-2 h-3 w-24 bg-white/[0.06]" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
