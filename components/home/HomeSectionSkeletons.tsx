export function BenefitsSkeleton() {
  return (
    <section className="py-20 md:py-32 bg-gradient-to-b from-zinc-100 to-white">
      <div className="container mx-auto px-4 md:px-6">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          <div className="space-y-6">
            <div className="h-6 w-24 bg-muted/50 rounded animate-pulse" />
            <div className="h-10 w-3/4 bg-muted/50 rounded animate-pulse" />
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <div
                  key={i}
                  className="h-5 bg-muted/50 rounded animate-pulse"
                  style={{ width: `${70 + i * 5}%` }}
                />
              ))}
            </div>
            <div className="flex gap-4 pt-2">
              <div className="h-12 w-36 bg-muted/50 rounded-xl animate-pulse" />
              <div className="h-12 w-36 bg-muted/50 rounded-xl animate-pulse" />
            </div>
          </div>
          <div className="h-[400px] bg-muted/50 rounded-2xl animate-pulse" />
        </div>
      </div>
    </section>
  );
}

export function FeaturedExpertsSkeleton() {
  return (
    <section className="py-20 md:py-28 bg-background">
      <div className="container mx-auto px-4 md:px-6">
        <div className="text-center mb-12 space-y-3">
          <div className="h-6 w-28 bg-muted/50 rounded animate-pulse mx-auto" />
          <div className="h-10 w-72 bg-muted/50 rounded animate-pulse mx-auto" />
          <div className="h-5 w-96 bg-muted/50 rounded animate-pulse mx-auto" />
        </div>
        <div className="flex gap-6 overflow-hidden">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="flex-shrink-0 w-[300px] h-[220px] bg-muted/50 rounded-xl animate-pulse"
            />
          ))}
        </div>
      </div>
    </section>
  );
}

export function TestimonialsSkeleton() {
  return (
    <>
      <section className="py-20 md:py-28 bg-gradient-to-b from-zinc-900 to-zinc-950">
        <div className="container mx-auto px-4 md:px-6">
          <div className="text-center mb-12 space-y-3">
            <div className="h-6 w-28 bg-zinc-800 rounded animate-pulse mx-auto" />
            <div className="h-10 w-72 bg-zinc-800 rounded animate-pulse mx-auto" />
          </div>
          <div className="flex gap-6 overflow-hidden">
            {[...Array(3)].map((_, i) => (
              <div
                key={i}
                className="flex-shrink-0 w-[350px] h-[180px] bg-zinc-800 rounded-xl animate-pulse"
              />
            ))}
          </div>
        </div>
      </section>
      <section className="py-20 bg-zinc-950">
        <div className="container mx-auto px-4 md:px-6">
          <div className="grid md:grid-cols-2 gap-8">
            <div className="h-[320px] bg-zinc-800 rounded-xl animate-pulse" />
            <div className="h-[320px] bg-zinc-800 rounded-xl animate-pulse" />
          </div>
        </div>
      </section>
    </>
  );
}
