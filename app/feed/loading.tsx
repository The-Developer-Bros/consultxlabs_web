export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-6">
      <div className="h-8 w-1/3 animate-pulse rounded-md bg-muted" />
      <div className="space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-32 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    </div>
  );
}
