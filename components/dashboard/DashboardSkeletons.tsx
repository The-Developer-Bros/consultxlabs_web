"use client";

import { Skeleton } from "@/components/ui/skeleton";

// Generic page skeleton with title and content
export function PageSkeleton() {
  return (
    <div className="p-6 lg:p-8">
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}

// Chat page skeleton
/**
 * Chat loading state.
 *
 * Sized to the same box the real chat surface occupies. It previously had NO
 * height — just `flex-1 flex m-4` — which only fills the viewport if the parent
 * is a flex container with a height. `loading.tsx` renders it as the whole
 * route, outside the `h-[calc(100dvh-…)]` wrapper the live `MessagesTab`
 * applies, so it collapsed to content height and covered a fraction of the
 * screen. The height calc here mirrors that wrapper: full viewport minus the
 * context bar, and minus the mobile tab bar below `md`.
 *
 * Colours are theme tokens rather than the hardcoded indigo it used to carry,
 * so it stops being the one light-only surface in a dark dashboard.
 */
export function ChatSkeleton() {
  return (
    <div className="-m-4 flex h-[calc(100dvh-3.5rem-4rem-var(--maintenance-banner-height,0px))] overflow-hidden border-border bg-card sm:-m-6 md:h-[calc(100dvh-3.5rem-var(--maintenance-banner-height,0px))] lg:-m-8">
      <ChatSkeletonPanes />
    </div>
  );
}

/**
 * The two panes without the full-bleed wrapper above, for the surfaces that
 * already supply their own — the Messages tabs, which show this while the
 * Stream socket connects. Nesting the wrapped version there would apply the
 * negative margin and the height calc twice.
 */
export function ChatSkeletonPanes() {
  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Channel list. Mirrors ChatLayout: full-width and visible below `md`,
          a fixed rail above it. The old `hidden sm:block` was the inverse of
          the loaded state — under 640px it showed the conversation and hid the
          list, which is the one pane the chat actually shows there. */}
      <div className="w-full shrink-0 space-y-4 border-r border-border p-4 md:w-80">
        <Skeleton className="h-10 w-full" />
        <div className="space-y-2">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="flex items-center gap-3 p-2">
              <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
              <div className="flex-1 space-y-1">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Conversation. Hidden below `md`, exactly as ChatLayout hides it until
          openConversation() runs. */}
      <div className="hidden flex-1 flex-col md:flex">
        <div className="flex items-center gap-3 border-b border-border p-4">
          <Skeleton className="h-10 w-10 rounded-full" />
          <Skeleton className="h-5 w-40" />
        </div>

        <div className="flex-1 space-y-4 overflow-hidden p-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-start gap-3">
              <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
              <div className="space-y-1">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-32" />
              </div>
            </div>
          ))}
          {[1, 2].map((i) => (
            <div key={`out-${i}`} className="flex items-start justify-end gap-3">
              <div className="space-y-1 text-right">
                <Skeleton className="ml-auto h-4 w-40" />
                <Skeleton className="ml-auto h-3 w-24" />
              </div>
              <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
            </div>
          ))}
        </div>

        <div className="border-t border-border p-4">
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    </div>
  );
}

// Documents/Table page skeleton
export function TableSkeleton() {
  return (
    <div className="p-6 lg:p-8">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
          <Skeleton className="h-10 w-32" />
        </div>

        {/* Table header */}
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border p-4">
            <div className="flex items-center gap-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-20" />
            </div>
          </div>

          {/* Table rows */}
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="border-b border-border p-4 last:border-0">
              <div className="flex items-center gap-4">
                <Skeleton className="h-10 w-10 rounded" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                </div>
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-6 w-20 rounded-full" />
                <Skeleton className="h-8 w-24" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Requests page skeleton
export function RequestsSkeleton() {
  return (
    <div className="flex flex-col lg:flex-row gap-6 p-6 lg:p-8">
      {/* Left panel */}
      <div className="flex-1 space-y-4">
        <Skeleton className="h-8 w-48" />
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="space-y-3 rounded-xl border border-border bg-card p-4"
          >
            <div className="flex items-center gap-3">
              <Skeleton className="h-10 w-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-6 w-20 rounded-full" />
            </div>
            <div className="flex gap-2">
              {[1, 2, 3].map((j) => (
                <Skeleton key={j} className="h-8 w-20" />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Right panel */}
      <div className="w-full lg:w-80 space-y-4">
        <Skeleton className="h-8 w-32" />
        <div className="space-y-4 rounded-xl border border-border bg-card p-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-8 w-8 rounded" />
              <div className="flex-1 space-y-1">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Home dashboard skeleton
/**
 * `withHeader={false}` when the caller already rendered the real header. Note
 * that a skeleton is made of `Skeleton` boxes with no text, image or SVG, so it
 * cannot trigger First Contentful Paint — measured on #1102, where the shell
 * HTML arrived at 458ms but FCP still waited ~6s for real text. If a surface
 * needs an early FCP, it has to render actual text, not a placeholder for it.
 */
export function HomeSkeleton({
  withHeader = true,
}: Readonly<{ withHeader?: boolean }> = {}) {
  return (
    <div className="flex-1 flex flex-col">
      {withHeader && (
        <div className="sticky top-0 z-30 border-b border-border/50 bg-muted/80 px-6 py-4 backdrop-blur-xl lg:px-8">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="mt-1 h-4 w-64" />
        </div>
      )}

      {/* Content */}
      <div className="space-y-6 px-6 py-6 lg:px-8">
        {/* Stats */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="rounded-xl border border-border bg-card p-5"
            >
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-8 w-16" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <Skeleton className="h-11 w-11 rounded-xl" />
              </div>
            </div>
          ))}
        </div>

        {/* Cards */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <div className="rounded-xl border border-border bg-card p-5">
              <Skeleton className="mb-4 h-6 w-40" />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {[1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-32 rounded-xl" />
                ))}
              </div>
            </div>
          </div>
          <div className="space-y-6">
            <div className="rounded-xl border border-border bg-card p-5">
              <Skeleton className="mb-4 h-6 w-32" />
              <div className="space-y-3">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-9 w-9 rounded-full" />
                    <div className="flex-1 space-y-1">
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-3 w-16" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Settings skeleton
export function SettingsSkeleton() {
  return (
    <div className="p-6 lg:p-8">
      <div className="space-y-6 max-w-3xl">
        <div className="space-y-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-64" />
        </div>

        {[1, 2, 3].map((section) => (
          <div
            key={section}
            className="space-y-4 rounded-xl border border-border bg-card p-6"
          >
            <Skeleton className="h-6 w-40" />
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                  <Skeleton className="h-10 w-24" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Help skeleton
export function HelpSkeleton() {
  return (
    <div className="w-full bg-background">
      <div className="w-full px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <div className="space-y-6 sm:space-y-10">
          {/* Header */}
          <div className="space-y-4 sm:space-y-6">
            <div className="flex items-start gap-3 sm:items-center sm:gap-4">
              <Skeleton className="h-11 w-11 shrink-0 rounded-xl sm:h-14 sm:w-14 sm:rounded-2xl" />
              <div className="space-y-1.5 sm:space-y-2">
                <Skeleton className="h-7 w-36 sm:h-8 sm:w-48" />
                <Skeleton className="h-4 w-56 sm:w-72" />
              </div>
            </div>

            {/* Search */}
            <Skeleton className="h-10 w-full rounded-lg sm:h-12 sm:rounded-xl lg:max-w-xl" />

            {/* Category filters */}
            <div className="flex flex-wrap gap-1.5 sm:gap-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton
                  key={i}
                  className="h-8 w-20 rounded-full sm:h-10 sm:w-24"
                />
              ))}
            </div>
          </div>

          {/* FAQ Groups */}
          {[1, 2, 3].map((group) => (
            <div
              key={group}
              className="space-y-3 rounded-xl border border-border bg-muted/50 p-4 sm:space-y-4 sm:rounded-2xl sm:p-6"
            >
              <div className="flex items-center gap-2.5 sm:gap-3">
                <Skeleton className="h-9 w-9 shrink-0 rounded-lg sm:h-10 sm:w-10 sm:rounded-xl" />
                <div className="space-y-1">
                  <Skeleton className="h-4 w-24 sm:h-5 sm:w-28" />
                  <Skeleton className="h-3 w-16 sm:w-20" />
                </div>
              </div>
              <div className="space-y-1.5 sm:space-y-2">
                {[1, 2].map((item) => (
                  <Skeleton
                    key={item}
                    className="h-12 w-full rounded-lg sm:h-14 sm:rounded-xl"
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Planner/Calendar skeleton
export function PlannerSkeleton() {
  return (
    <div className="px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
      <div className="space-y-6 sm:space-y-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 sm:gap-0">
          <div className="space-y-1.5 sm:space-y-2">
            <Skeleton className="h-7 sm:h-8 w-40 sm:w-48" />
            <Skeleton className="h-4 w-56 sm:w-64" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-9 sm:h-10 w-full sm:w-32" />
            <Skeleton className="h-9 sm:h-10 w-full sm:w-32" />
          </div>
        </div>

        {/* Event cards grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4 sm:gap-5 lg:gap-6">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5"
            >
              <div className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 sm:h-12 sm:w-12 rounded-lg sm:rounded-xl shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 sm:h-5 w-full max-w-[150px]" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
              <Skeleton className="h-10 sm:h-12 w-full" />
              <div className="flex justify-between items-center pt-2">
                <Skeleton className="h-5 sm:h-6 w-16 sm:w-20" />
                <Skeleton className="h-6 w-20 rounded-full" />
              </div>
            </div>
          ))}
        </div>

        {/* Stats section */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="rounded-xl bg-muted/80 p-4 sm:rounded-2xl sm:p-5"
            >
              <Skeleton className="h-3 sm:h-4 w-20 sm:w-24 mb-2" />
              <Skeleton className="h-6 sm:h-8 w-12 sm:w-16" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


/** Appointment detail: banner + content columns. */
export function AppointmentDetailSkeleton() {
  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div className="space-y-3 rounded-xl border border-border bg-card p-6">
        <Skeleton className="h-6 w-32 rounded-full" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
        <div className="flex flex-wrap gap-2 pt-2">
          <Skeleton className="h-10 w-28" />
          <Skeleton className="h-10 w-28" />
          <Skeleton className="h-10 w-28" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <div className="space-y-4">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

/** Admin analytics: 4 stat cards + chart panels. */
export function AnalyticsSkeleton() {
  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="space-y-3 rounded-xl border border-border bg-card p-5"
          >
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    </div>
  );
}
