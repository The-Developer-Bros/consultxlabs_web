export default function Loading() {
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-md items-center justify-center p-6">
      <div className="w-full space-y-4 rounded-xl border border-border p-6">
        <div className="h-8 w-1/2 animate-pulse rounded-md bg-muted" />
        <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
        <div className="h-10 w-full animate-pulse rounded-lg bg-muted" />
        <div className="h-10 w-full animate-pulse rounded-lg bg-muted" />
      </div>
    </div>
  );
}
