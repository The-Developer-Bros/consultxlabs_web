import Link from "next/link";
import { ArrowRight, Inbox } from "lucide-react";

import type { NeedsYouSummary } from "@/lib/data/needs-you";

/**
 * Cross-context "needs you" roll-up.
 *
 * ADR 19 accepts, as a stated cost of splitting dashboards by org-ness, that a
 * consultant working through an organization has to visit more than one
 * dashboard. It also fixes the only sanctioned remedy: a cross-context summary
 * must be "a derived read rather than by re-merging the views". So this card
 * shows counts and links out — it never renders the work in place, and clicking
 * always lands in the dashboard that owns it. Each number stays authoritative
 * in exactly one place.
 *
 * Renders nothing when there is nothing waiting, so a purely B2C consultant
 * never sees an org concept they have no use for.
 */
export function NeedsYouCard({ summary }: Readonly<{ summary: NeedsYouSummary }>) {
  if (summary.total === 0) return null;

  // With only a personal context there is nothing cross-context to reconcile,
  // and the Requests nav entry already says this. The card earns its space only
  // once the work is genuinely spread across dashboards.
  if (summary.contexts.length === 1 && summary.contexts[0].organizationId === null) {
    return null;
  }

  return (
    <section
      aria-labelledby="needs-you-heading"
      className="rounded-xl border border-border bg-card p-4"
    >
      <div className="mb-3 flex items-center gap-2">
        <Inbox className="h-4 w-4 text-muted-foreground" />
        <h2 id="needs-you-heading" className="text-sm font-semibold">
          Needs you
        </h2>
        <span className="text-xs text-muted-foreground">
          across {summary.contexts.length} dashboards
        </span>
      </div>

      <ul className="divide-y divide-border">
        {summary.contexts.map((context) => (
          <li key={context.organizationId ?? "personal"}>
            <Link
              href={context.href}
              className="flex items-center justify-between gap-3 py-2.5 text-sm transition-colors hover:text-foreground"
            >
              <span className="min-w-0 flex-1 truncate font-medium">
                {context.label}
              </span>
              <span className="text-muted-foreground">
                {context.pendingRequests}{" "}
                {context.pendingRequests === 1 ? "request" : "requests"}
              </span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
