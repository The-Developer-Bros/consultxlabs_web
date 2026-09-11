"use client";

/**
 * Tabs whose active panel lives in the URL as `?tab=<value>`.
 *
 * The dashboard IA consolidation collapsed a number of sidebar entries into
 * tabs on a single page (Members absorbed Learners/Experts/Invitations,
 * Operations absorbed the four read-only tables, Settings absorbed SSO and the
 * integrations). Those retired routes redirect to `?tab=` targets, so the tab
 * state has to be addressable — a plain `defaultValue` would drop the user on
 * the first panel regardless of where they came from.
 *
 * URL writes use `history.replaceState` (not `router.replace`) so switching a
 * tab does not trigger a Next.js soft navigation / RSC refetch. Local state
 * keeps the active panel in sync immediately; the address bar stays shareable.
 * History is not pushed — back still leaves the page rather than walking
 * every tab glance.
 *
 * Tabs are filtered by `show` so a caller can gate individual panels off the
 * same permission matrix that gates the sidebar — a hidden tab must not render
 * a trigger that 403s when clicked.
 */

import { useCallback, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface UrlTab {
  value: string;
  label: string;
  content: React.ReactNode;
  /** Omit or pass true to show. False removes the trigger and the panel. */
  show?: boolean;
}

export function UrlTabs({
  tabs,
  paramName = "tab",
  className,
}: {
  tabs: UrlTab[];
  paramName?: string;
  className?: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const visible = tabs.filter((t) => t.show !== false);
  const requested = searchParams?.get(paramName);
  // Fall back to the first visible tab when the param is absent or names a tab
  // this user can't see — a stale bookmark shouldn't render an empty page.
  const urlActive =
    visible.find((t) => t.value === requested)?.value ?? visible[0]?.value;

  // Local override so replaceState (which does not update useSearchParams)
  // still flips the panel immediately.
  const [localActive, setLocalActive] = useState<string | null>(null);
  const active = localActive ?? urlActive;

  // External URL change (e.g. redirect into ?tab=) wins over a stale local pick.
  useEffect(() => {
    setLocalActive(null);
  }, [requested]);

  const onValueChange = useCallback(
    (value: string) => {
      setLocalActive(value);
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.set(paramName, value);
      // Panels that paginate all read the same `?page=`. Without this, moving
      // to page 3 of Documents and then clicking Trials would open Trials on
      // page 3 — or on an empty page, if it has fewer.
      params.delete("page");
      const qs = params.toString();
      const target = qs ? pathname + "?" + qs : pathname;
      const current = window.location.pathname + window.location.search;
      if (target !== current) {
        window.history.replaceState(window.history.state, "", target);
      }
    },
    [paramName, pathname, searchParams],
  );

  if (!active) return null;

  return (
    <Tabs value={active} onValueChange={onValueChange} className={className}>
      <TabsList>
        {visible.map((t) => (
          <TabsTrigger key={t.value} value={t.value}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>

      {visible.map((t) => (
        <TabsContent key={t.value} value={t.value} className="space-y-6">
          {t.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
