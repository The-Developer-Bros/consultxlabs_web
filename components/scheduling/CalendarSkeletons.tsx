import { Skeleton } from "@/components/ui/skeleton";

/**
 * Week heatmap / slot calendar grid.
 * Matches UnifiedCalendar week layout: time gutter + 7 day columns.
 */
export function CalendarGridSkeleton({
  className,
}: Readonly<{ className?: string }>) {
  return (
    <div
      className={
        className
          ? `flex min-h-0 flex-1 flex-col gap-3 ${className}`
          : "flex min-h-0 flex-1 flex-col gap-3"
      }
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-2">
          <Skeleton className="h-9 w-9" />
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-9" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-20" />
        </div>
      </div>
      <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] gap-px overflow-hidden rounded-xl border border-border bg-border">
        <div className="bg-card p-2" />
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={`h-${i}`} className="bg-card p-2 text-center">
            <Skeleton className="mx-auto h-3 w-8" />
            <Skeleton className="mx-auto mt-1 h-5 w-6" />
          </div>
        ))}
        {Array.from({ length: 8 }).map((_, row) => (
          <div key={`row-${row}`} className="contents">
            <div className="bg-card p-1">
              <Skeleton className="mx-auto h-3 w-8" />
            </div>
            {Array.from({ length: 7 }).map((_, col) => (
              <div key={`c-${row}-${col}`} className="min-h-12 bg-card p-1">
                <Skeleton className="h-full min-h-10 w-full rounded-md" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Allocate / reschedule / timings page: header + calendar + footer. */
export function HeatmapSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 sm:p-6">
      <div className="flex shrink-0 items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
      <Skeleton className="h-4 w-full max-w-xl" />
      <CalendarGridSkeleton />
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border pt-4">
        <Skeleton className="h-10 w-28" />
        <Skeleton className="h-10 w-36" />
        <Skeleton className="h-10 w-28" />
      </div>
    </div>
  );
}
