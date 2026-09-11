export default function Loading() {
  return (
    <div
      className="mx-auto w-full max-w-7xl space-y-10 px-4 py-8"
      style={{ paddingTop: "160px" }}
    >
      <div className="h-64 w-full animate-pulse rounded-2xl bg-muted" />
      <div className="space-y-3">
        <div className="h-6 w-40 animate-pulse rounded-md bg-muted" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-32 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    </div>
  );
}
