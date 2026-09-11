export default function Loading() {
  return (
    <div className="min-h-screen bg-muted">
      <div className="relative h-48 overflow-hidden bg-gradient-to-br from-zinc-800 to-zinc-900 md:h-64" />
      <div className="mx-auto max-w-[1100px] px-4 md:px-8">
        <div className="py-4">
          <div className="h-4 w-32 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="relative -mt-16 mb-8 rounded-2xl border border-border bg-card p-6 shadow-sm md:p-8">
          <div className="flex flex-col items-start gap-5 sm:flex-row">
            <div className="h-20 w-20 flex-shrink-0 animate-pulse rounded-2xl bg-muted" />
            <div className="flex-1 space-y-3">
              <div className="h-7 w-56 animate-pulse rounded-md bg-muted" />
              <div className="h-4 w-40 animate-pulse rounded-md bg-muted" />
              <div className="h-4 w-3/4 animate-pulse rounded-md bg-muted" />
            </div>
          </div>
        </div>
        <div className="grid gap-4 pb-8 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-40 animate-pulse rounded-xl bg-card" />
          ))}
        </div>
      </div>
    </div>
  );
}
