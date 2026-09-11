export default function Loading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted px-4">
      <div className="w-full max-w-md space-y-6 rounded-lg bg-card p-8 shadow-md">
        <div className="space-y-3 text-center">
          <div className="mx-auto h-12 w-12 animate-pulse rounded-full bg-muted" />
          <div className="mx-auto h-7 w-48 animate-pulse rounded-md bg-muted" />
          <div className="mx-auto h-4 w-64 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="space-y-4">
          <div className="h-10 animate-pulse rounded-md bg-muted" />
          <div className="h-10 animate-pulse rounded-md bg-muted" />
          <div className="h-10 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="h-10 w-full animate-pulse rounded-md bg-muted" />
      </div>
    </div>
  );
}
