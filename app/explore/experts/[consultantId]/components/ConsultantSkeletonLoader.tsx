import React from "react";
import { Skeleton } from "@/components/ui/skeleton";

export const ConsultantSkeletonLoader: React.FC = () => {
  return (
    <div className="min-h-screen bg-background">
      {/* Back navigation */}
      <div className="border-b border-border">
        <div className="mx-auto max-w-[1600px] px-4 py-4 md:px-8 lg:px-12">
          <Skeleton className="h-4 w-28" />
        </div>
      </div>

      <div className="mx-auto max-w-[1600px] px-4 py-8 md:px-8 md:py-12 lg:px-12">
        <div className="flex flex-col gap-8 xl:flex-row xl:gap-12">
          {/* Main column */}
          <div className="min-w-0 flex-1 space-y-6">
            {/* Profile header */}
            <div className="rounded-2xl border border-border bg-card p-6 md:p-8">
              <div className="flex flex-col gap-6 sm:flex-row">
                <Skeleton className="h-32 w-32 shrink-0 rounded-2xl md:h-40 md:w-40" />
                <div className="flex-1 space-y-3">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-8 w-1/2 md:w-1/3" />
                  <Skeleton className="h-5 w-3/4 md:w-1/2" />
                  <div className="flex flex-wrap gap-2 pt-2">
                    <Skeleton className="h-6 w-24 rounded-full" />
                    <Skeleton className="h-6 w-20 rounded-full" />
                    <Skeleton className="h-6 w-16 rounded-full" />
                  </div>
                </div>
              </div>
            </div>

            {/* About */}
            <div className="space-y-3 rounded-2xl border border-border bg-card p-6 md:p-8">
              <Skeleton className="h-6 w-28" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
            </div>

            {/* Availability */}
            <div className="rounded-2xl border border-border bg-card p-6 md:p-8">
              <Skeleton className="mb-5 h-6 w-36" />
              <div className="grid grid-cols-7 gap-2">
                {Array.from({ length: 7 }).map((_, i) => (
                  <Skeleton key={i} className="h-28 rounded-xl" />
                ))}
              </div>
            </div>
          </div>

          {/* Booking panel */}
          <div className="w-full shrink-0 xl:w-[450px] 2xl:w-[500px]">
            <div className="space-y-5 rounded-2xl border border-white/10 bg-zinc-950 p-6">
              <Skeleton className="mx-auto h-6 w-40 bg-zinc-800" />
              <Skeleton className="h-11 w-full rounded-xl bg-zinc-800" />
              <div className="grid grid-cols-7 gap-2">
                {Array.from({ length: 35 }).map((_, i) => (
                  <Skeleton
                    key={i}
                    className="mx-auto h-9 w-9 rounded-full bg-zinc-800"
                  />
                ))}
              </div>
              <div className="space-y-2">
                <Skeleton className="h-12 w-full rounded-xl bg-zinc-800" />
                <Skeleton className="h-12 w-full rounded-xl bg-zinc-800" />
                <Skeleton className="h-12 w-full rounded-xl bg-zinc-800" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
