"use client";

import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

interface FacetRailProps {
  /** The facet groups. Rendered identically in the rail and the mobile sheet. */
  children: React.ReactNode;
  /** Count of currently-applied filters, shown on the mobile trigger. */
  activeCount?: number;
  onClearAll?: () => void;
  /** Result count, e.g. "24 organisations". */
  resultSummary?: string;
}

/**
 * Shared filter shell for the explore surfaces.
 *
 * Desktop gets a sticky left rail; mobile gets a slide-out Sheet rather than a
 * separate filter page, which is the pattern NN/g recommends because it keeps
 * the result list one dismissal away. Offset by --header-height so the sticky
 * rail clears the fixed navbar.
 */
export default function FacetRail({
  children,
  activeCount = 0,
  onClearAll,
  resultSummary,
}: FacetRailProps) {
  const [open, setOpen] = useState(false);

  const header = (
    <div className="flex items-center justify-between">
      <span className="text-sm font-semibold text-foreground">Filters</span>
      {activeCount > 0 && onClearAll && (
        <button
          type="button"
          onClick={onClearAll}
          className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Clear all
        </button>
      )}
    </div>
  );

  return (
    <>
      {/* Mobile trigger */}
      <div className="flex items-center justify-between gap-3 lg:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" className="gap-2">
              <SlidersHorizontal className="h-4 w-4" />
              Filters
              {activeCount > 0 && (
                <span className="ml-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-primary-foreground">
                  {activeCount}
                </span>
              )}
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[88%] max-w-sm overflow-y-auto">
            <SheetHeader>
              <SheetTitle>Filters</SheetTitle>
            </SheetHeader>
            <div className="mt-4 space-y-1">
              {activeCount > 0 && onClearAll && (
                <div className="pb-2">{header}</div>
              )}
              {children}
            </div>
          </SheetContent>
        </Sheet>
        {resultSummary && (
          <span className="text-sm text-muted-foreground">{resultSummary}</span>
        )}
      </div>

      {/* Desktop rail */}
      <aside
        className="hidden lg:block"
        style={{
          position: "sticky",
          top: "calc(var(--header-height, 5rem) + 1rem)",
          alignSelf: "start",
        }}
        aria-label="Filters"
      >
        <div className="max-h-[calc(100vh-var(--header-height,5rem)-3rem)] overflow-y-auto rounded-2xl border border-border bg-card p-4">
          {header}
          <div className="mt-2">{children}</div>
        </div>
      </aside>
    </>
  );
}
