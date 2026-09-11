/** Shared split-panel auth chrome — matches signin/signup loading.tsx anatomy. */
export function AuthFormSkeleton() {
  return (
    <div className="flex min-h-screen">
      <div className="hidden animate-pulse bg-muted lg:block lg:w-1/2" />
      <div className="flex w-full flex-col items-center justify-center bg-neutral-950 p-8 lg:w-1/2">
        <div className="w-full max-w-md space-y-6">
          <div className="h-8 w-32 animate-pulse rounded-md bg-muted" />
          <div className="space-y-3">
            <div className="h-10 animate-pulse rounded-md bg-muted" />
            <div className="h-10 animate-pulse rounded-md bg-muted" />
          </div>
          <div className="h-10 animate-pulse rounded-md bg-muted" />
        </div>
      </div>
    </div>
  );
}
