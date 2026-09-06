/** Intro placeholder shared by the section skeletons: eyebrow, h2, lede. */
function IntroSkeleton({ dark = false }: { dark?: boolean }) {
  const bar = dark ? "bg-white/[0.06]" : "bg-muted";
  return (
    <div className="mb-10 md:mb-14">
      <div className={`h-3 w-24 animate-pulse rounded ${bar}`} />
      <div
        className={`mt-3 h-9 w-80 max-w-full animate-pulse rounded ${bar}`}
      />
      <div
        className={`mt-4 h-5 w-96 max-w-full animate-pulse rounded ${bar}`}
      />
    </div>
  );
}

export function BenefitsSkeleton() {
  return (
    <section className="bg-muted/40 py-20 md:py-28">
      <div className="container mx-auto px-4 md:px-6">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-20">
          <div>
            <IntroSkeleton />
            <div className="divide-y divide-border border-y border-border">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="grid grid-cols-[2.5rem_1fr] py-5">
                  <div className="h-4 w-6 animate-pulse rounded bg-muted" />
                  <div>
                    <div className="h-5 w-48 animate-pulse rounded bg-muted" />
                    <div className="mt-2 h-4 w-full animate-pulse rounded bg-muted" />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="h-[400px] animate-pulse rounded-2xl border border-border bg-muted" />
        </div>
      </div>
    </section>
  );
}

export function FeaturedExpertsSkeleton() {
  return (
    <section className="overflow-hidden bg-background py-20 md:py-28">
      <div className="container mx-auto px-4 md:px-6">
        <IntroSkeleton />
      </div>
      <div className="flex overflow-hidden px-4 md:px-6">
        {[...Array(4)].map((_, i) => (
          <div
            key={i}
            className="mx-2 h-[196px] w-[300px] flex-shrink-0 animate-pulse rounded-2xl border border-border bg-muted"
          />
        ))}
      </div>
    </section>
  );
}

export function TestimonialsSkeleton() {
  return (
    <section className="overflow-hidden bg-zinc-950 py-20 md:py-28">
      <div className="container mx-auto px-4 md:px-6">
        <IntroSkeleton dark />
      </div>
      {[0, 1].map((row) => (
        <div key={row} className="mb-4 flex overflow-hidden px-4 md:px-6">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="mx-2 h-[212px] w-[360px] flex-shrink-0 animate-pulse rounded-2xl border border-white/10 bg-white/[0.04]"
            />
          ))}
        </div>
      ))}
    </section>
  );
}
