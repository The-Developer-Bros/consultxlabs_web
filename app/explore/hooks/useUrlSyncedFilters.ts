"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ReadonlyParams } from "@/lib/explore/filter-codec";
import { shouldSkipUrlHydrate } from "@/lib/explore/url-hydrate-skip";

const URL_SYNC_DEBOUNCE_MS = 300;

interface UseUrlSyncedFiltersOptions<T> {
  /** Pathname to write back to, e.g. "/explore/enterprise/organisations". */
  basePath: string;
  defaults: T;
  fromSearchParams: (params: ReadonlyParams) => T;
  toSearchParams: (filters: T) => string;
}

export interface UrlSyncedFilters<T> {
  filters: T;
  updateFilters: (partial: Partial<T>) => void;
  clearFilters: () => void;
}

/**
 * Filter state plus its URL mirror, generalised from `useExpertsFilters` so
 * every explore surface gets bookmarkable filters (programs previously synced
 * only `?tab=`).
 *
 * Two behaviours are carried over deliberately from the experts implementation:
 *
 * - `updateFilters` is SYNCHRONOUS. Consumers that fire rapid mutations (search
 *   typing, slider drags) debounce their own propagation; doing it here would
 *   make every consumer's query key lag behind the UI.
 * - URL writes go through `window.history.replaceState`, not `router.replace`.
 *   Next 15's App Router re-renders the tree via `useSearchParams` reactivity
 *   even with `{ scroll: false }`, which causes mid-typing scroll-to-top jumps.
 *
 * Soft-nav into the same route with a new query (e.g. navbar
 * `?type=EXPERT_NETWORK`) must rehydrate filters from the URL. Without that,
 * the mount-time defaults win and the debounced write strips the param.
 */
export function useUrlSyncedFilters<T>({
  basePath,
  defaults,
  fromSearchParams,
  toSearchParams,
}: UseUrlSyncedFiltersOptions<T>): UrlSyncedFilters<T> {
  const searchParams = useSearchParams();

  // Hydrate from the URL once so shareable links work. On the server
  // `searchParams` is empty in client components, so this falls back to
  // defaults during SSR; the effect below rehydrates on the client.
  const [filters, setFilters] = useState<T>(() =>
    fromSearchParams(searchParams),
  );

  const updateFilters = useCallback((partial: Partial<T>) => {
    setFilters((prev) => ({ ...prev, ...partial }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(defaults);
    // `defaults` is a module-level constant at every call site; listing it
    // keeps the lint rule happy without changing identity across renders.
  }, [defaults]);

  // Exact query string we last wrote via replaceState (normalized). Null when
  // no self-write is awaiting an echo through `useSearchParams`.
  const pendingWrittenQs = useRef<string | null>(null);

  useEffect(() => {
    // Normalize through the same codec we write with so param order / encoding
    // cannot false-mismatch a self-write.
    const incomingQs = toSearchParams(fromSearchParams(searchParams));
    const { skip, nextPending } = shouldSkipUrlHydrate(
      pendingWrittenQs.current,
      incomingQs,
    );
    pendingWrittenQs.current = nextPending;
    if (skip) return;
    setFilters(fromSearchParams(searchParams));
  }, [searchParams, fromSearchParams, toSearchParams]);

  const urlSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (urlSyncRef.current) clearTimeout(urlSyncRef.current);
    urlSyncRef.current = setTimeout(() => {
      const qs = toSearchParams(filters);
      // Preserve the hash — see the note in useExpertsFilters.
      const hash = window.location.hash;
      const target = `${basePath}${qs ? `?${qs}` : ""}${hash}`;
      const current = window.location.pathname + window.location.search + hash;
      if (target !== current) {
        pendingWrittenQs.current = qs;
        window.history.replaceState(window.history.state, "", target);
      }
    }, URL_SYNC_DEBOUNCE_MS);

    return () => {
      if (urlSyncRef.current) clearTimeout(urlSyncRef.current);
    };
  }, [filters, basePath, toSearchParams]);

  return { filters, updateFilters, clearFilters };
}
