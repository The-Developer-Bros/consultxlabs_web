export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-xl space-y-4 p-6">
      <div className="h-8 w-1/3 animate-pulse rounded-md bg-muted" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    </div>
  );
}
