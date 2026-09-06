export default function Loading() {
  return (
    <main className="min-h-screen bg-background">
      {/* Dark hero — matches ExploreHero's band so the swap isn't a flash. */}
      <section className="border-b border-white/10 bg-zinc-950 pb-16 pt-32 md:pb-20 md:pt-40">
        <div className="mx-auto max-w-[1600px] px-4 md:px-8 lg:px-12">
          <div className="max-w-3xl">
            <div className="h-3 w-24 animate-pulse rounded bg-zinc-800" />
            <div className="mt-5 h-11 w-full max-w-xl animate-pulse rounded bg-zinc-800" />
            <div className="mt-3 h-11 w-full max-w-md animate-pulse rounded bg-zinc-800" />
            <div className="mt-6 h-5 w-full max-w-lg animate-pulse rounded bg-zinc-800" />
            <div className="mt-10 flex flex-wrap gap-x-10 gap-y-6">
              {[1, 2, 3].map((i) => (
                <div key={i}>
                  <div className="h-8 w-16 animate-pulse rounded bg-zinc-800" />
                  <div className="mt-1.5 h-3 w-24 animate-pulse rounded bg-zinc-800" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Featured strip */}
      <section className="border-b border-border bg-muted/40 py-16 md:py-20">
        <div className="mx-auto max-w-[1600px] px-4 md:px-8 lg:px-12">
          <div className="mb-10 md:mb-14">
            <div className="h-3 w-28 animate-pulse rounded bg-muted" />
            <div className="mt-3 h-9 w-72 animate-pulse rounded bg-muted" />
            <div className="mt-4 h-5 w-full max-w-lg animate-pulse rounded bg-muted" />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="h-52 animate-pulse rounded-2xl border border-border bg-card"
              />
            ))}
          </div>
        </div>
      </section>

      {/* Toolbar + rail + results */}
      <section className="mx-auto max-w-[1600px] px-4 py-10 md:px-8 md:py-16 lg:px-12">
        <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="h-11 w-72 animate-pulse rounded-xl bg-muted" />
          <div className="h-11 w-full animate-pulse rounded-xl bg-muted lg:max-w-xl lg:flex-1" />
        </div>
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[280px_1fr]">
          <div className="hidden h-[520px] animate-pulse rounded-2xl bg-muted lg:block" />
          <div className="min-w-0 space-y-6">
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="h-48 animate-pulse rounded-2xl bg-muted"
              />
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
