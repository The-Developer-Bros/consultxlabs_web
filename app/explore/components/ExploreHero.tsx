interface ExploreHeroStat {
  key: string;
  display: string;
  label: string;
}

interface ExploreHeroProps {
  eyebrow: string;
  title: string;
  titleAccent?: string;
  description: string;
  stats: ExploreHeroStat[];
  /** Rendered instead of the figures when there is nothing real to show. */
  emptyStatsText: string;
}

/**
 * The dark masthead shared by the two explore listings.
 *
 * Deliberately hook-free and without a "use client" directive so the same
 * component renders inside the experts RSC and inside the programs client
 * component without either surface needing its own copy.
 */
export default function ExploreHero({
  eyebrow,
  title,
  titleAccent,
  description,
  stats,
  emptyStatsText,
}: ExploreHeroProps) {
  return (
    <section className="relative overflow-hidden border-b border-white/10 bg-zinc-950 pb-16 pt-32 text-white md:pb-20 md:pt-40">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(60%_50%_at_50%_0%,rgba(255,255,255,0.08),transparent)]"
      />

      <div className="relative mx-auto max-w-[1600px] px-4 md:px-8 lg:px-12">
        <div className="max-w-3xl">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
            {eyebrow}
          </p>

          <h1 className="mt-4 text-fluid-4xl font-semibold tracking-[-0.03em] md:text-fluid-5xl">
            {title}
            {titleAccent && (
              <>
                <br />
                <span className="text-zinc-400">{titleAccent}</span>
              </>
            )}
          </h1>

          <p className="mt-5 max-w-2xl text-base text-zinc-400 md:text-lg">
            {description}
          </p>

          {stats.length > 0 ? (
            <div className="mt-10 flex flex-wrap gap-x-10 gap-y-6">
              {stats.map((stat) => (
                <div key={stat.key}>
                  <div className="text-3xl font-semibold tabular-nums">
                    {stat.display}
                  </div>
                  <div className="mt-1.5 text-xs uppercase tracking-[0.18em] text-zinc-500">
                    {stat.label}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-8 text-sm text-zinc-500">{emptyStatsText}</p>
          )}
        </div>
      </div>
    </section>
  );
}
