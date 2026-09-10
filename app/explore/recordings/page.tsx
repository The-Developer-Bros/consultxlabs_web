import { Suspense } from "react";
import Link from "next/link";
import { PlayCircle, Clock } from "lucide-react";
import { listPublicRecordings } from "@/lib/data/recordings-explore";
import { withBuildTimeRetry } from "@/lib/data/fail-open";
import { formatCurrencyAmount } from "@/utils/formatting";

// ISR — same rationale as /explore/experts: anonymous, session-free listing;
// prerendered HTML off the CDN. Publish/unpublish purge on demand at the
// write sites (see publish route follow-up).
export const revalidate = 300;

export const metadata = {
  title: "Recordings Library | Familiarise",
  description:
    "Buy recorded webinars and classes from verified consultants — learn on your schedule.",
};

function formatPrice(paise: number): string {
  return formatCurrencyAmount(paise, "INR");
}

async function RecordingsGrid() {
  // Deliberately LOUD: __tests__/explore/isr-routes-never-fail-open.test.ts
  // enforces that ISR listings never mask data-layer failures.
  const { items } = await withBuildTimeRetry(() =>
    listPublicRecordings({ perPage: 48 }),
  );

  if (items.length === 0) {
    return (
      <div className="py-24 text-center text-muted-foreground">
        <PlayCircle className="mx-auto mb-4 h-12 w-12 opacity-40" />
        <p className="text-lg font-medium">No published recordings yet</p>
        <p className="mt-1 text-sm">
          Consultants can publish webinar and class replays from their dashboard.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {items.map((rec) => (
        <Link
          key={rec.id}
          href={rec.slug ? `/explore/recordings/${rec.slug}` : `/explore/recordings`}
          className="group rounded-xl border bg-card overflow-hidden hover:shadow-md transition-shadow"
        >
          <div className="aspect-video relative bg-muted">
            {rec.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={rec.thumbnailUrl}
                alt={rec.listingTitle}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <PlayCircle className="h-10 w-10 text-muted-foreground/50" />
              </div>
            )}
            <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {rec.durationInMinutes}m
            </span>
          </div>
          <div className="p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {rec.planType}
              </span>
              <span className="font-semibold text-primary">
                {formatPrice(rec.listPricePaise)}
              </span>
            </div>
            <h3 className="line-clamp-2 text-sm font-medium group-hover:text-primary transition-colors">
              {rec.listingTitle}
            </h3>
            <p className="text-xs text-muted-foreground truncate">
              {rec.consultant.name}
              {rec.consultant.headline ? ` · ${rec.consultant.headline}` : ""}
            </p>
          </div>
        </Link>
      ))}
    </div>
  );
}

export default function ExploreRecordingsPage() {
  return (
    <div className="container mx-auto px-4 py-10 space-y-8">
      <header className="space-y-2 text-center">
        <h1 className="text-3xl font-bold tracking-tight">Recordings Library</h1>
        <p className="text-muted-foreground max-w-2xl mx-auto">
          Replays of paid webinars and classes, published by their consultants.
          Buy once, watch anytime.
        </p>
      </header>
      <Suspense fallback={<div className="py-24 text-center text-muted-foreground">Loading recordings…</div>}>
        <RecordingsGrid />
      </Suspense>
    </div>
  );
}
