export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-6">
      <div className="h-8 w-1/3 animate-pulse rounded-md bg-muted" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-40 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    </div>
  );
}
