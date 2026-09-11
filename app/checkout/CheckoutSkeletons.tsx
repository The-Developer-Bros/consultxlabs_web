import { Skeleton } from "@/components/ui/skeleton";

/** Checkout two-column plan layout (fills plans/layout grid). */
export function CheckoutPlanSkeleton() {
  return (
    <>
      <div className="flex flex-col gap-6 border-r border-border bg-gradient-to-br from-muted via-background to-muted p-6 sm:p-8">
        <div className="flex items-center gap-4">
          <Skeleton className="h-12 w-12 shrink-0 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-28" />
          </div>
        </div>
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-8 bg-card p-6 sm:p-8">
        <Skeleton className="h-48 rounded-xl" />
        <div className="space-y-4">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      </div>
    </>
  );
}

/** Checkout success/failure centered card. */
export function CheckoutResultSkeleton() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted p-6">
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-card p-8">
        <Skeleton className="mx-auto h-16 w-16 rounded-full" />
        <Skeleton className="mx-auto h-7 w-48" />
        <Skeleton className="mx-auto h-4 w-64" />
        <Skeleton className="mt-4 h-11 w-full rounded-xl" />
      </div>
    </main>
  );
}
