import { Skeleton } from "@/components/ui/skeleton";

/** Meeting lobby / room chrome (setup preview + sidebar). */
export function MeetingRoomSkeleton() {
  return (
    <main className="relative min-h-screen bg-gradient-to-br from-zinc-900 via-zinc-950 to-black">
      <div className="mx-auto grid h-screen max-w-7xl gap-6 p-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:p-8">
        <div className="flex min-h-0 flex-col gap-4">
          <Skeleton className="aspect-video w-full rounded-2xl bg-zinc-800" />
          <div className="flex items-center justify-center gap-3">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton
                key={i}
                className="h-12 w-12 rounded-full bg-zinc-800"
              />
            ))}
          </div>
        </div>
        <div className="space-y-4 rounded-2xl border border-zinc-800 bg-card/95 p-6">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <div className="space-y-3 pt-4">
            <Skeleton className="h-11 w-full rounded-lg" />
            <Skeleton className="h-11 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-xl" />
          </div>
        </div>
      </div>
    </main>
  );
}
