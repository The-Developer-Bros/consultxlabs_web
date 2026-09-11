export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-6">
      <div className="flex items-center gap-4">
        <div className="h-20 w-20 animate-pulse rounded-full bg-muted" />
        <div className="space-y-2">
          <div className="h-6 w-40 animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-56 animate-pulse rounded bg-muted" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-32 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    </div>
  );
}
