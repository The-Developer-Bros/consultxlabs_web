import { Skeleton } from "@/components/ui/skeleton";

/** Onboarding multi-step wizard shell. */
export function OnboardingWizardSkeleton() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-muted to-background">
      <header className="sticky top-0 z-20 border-b border-border bg-card/80 backdrop-blur">
        <div className="container mx-auto flex h-14 items-center justify-between px-4">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-24" />
        </div>
      </header>
      <main className="container mx-auto max-w-3xl space-y-8 px-4 py-10">
        <div className="flex items-center justify-center gap-2 sm:gap-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-2 sm:gap-3">
              <Skeleton className="h-9 w-9 rounded-full sm:h-10 sm:w-10" />
              {i < 5 && <Skeleton className="hidden h-0.5 w-8 sm:block" />}
            </div>
          ))}
        </div>
        <div className="space-y-6 rounded-xl border border-border bg-card p-6 shadow-lg sm:p-8">
          <div className="space-y-2">
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-4 w-72" />
          </div>
          <div className="space-y-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-11 w-full rounded-lg" />
              </div>
            ))}
          </div>
          <div className="flex justify-between pt-2">
            <Skeleton className="h-11 w-28 rounded-lg" />
            <Skeleton className="h-11 w-28 rounded-lg" />
          </div>
        </div>
      </main>
    </div>
  );
}
