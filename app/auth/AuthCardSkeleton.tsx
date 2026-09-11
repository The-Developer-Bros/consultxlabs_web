/** Centered auth card — matches verify-email / reset-password loading.tsx. */
export function AuthCardSkeleton() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 p-4">
      <div className="w-full max-w-md space-y-5">
        <div className="h-7 w-40 animate-pulse rounded-md bg-muted" />
        <div className="h-4 w-3/4 animate-pulse rounded-md bg-muted" />
        <div className="h-10 animate-pulse rounded-md bg-muted" />
        <div className="h-10 animate-pulse rounded-md bg-muted" />
        <div className="h-10 w-28 animate-pulse rounded-md bg-muted" />
      </div>
    </div>
  );
}
