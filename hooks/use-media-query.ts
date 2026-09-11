"use client";

import { useSyncExternalStore } from "react";

/**
 * SSR-safe media-query hook. Server and first client render return the
 * `defaultValue` (avoids hydration mismatch); the real match syncs on mount.
 */
export function useMediaQuery(query: string, defaultValue = false): boolean {
  const subscribe = (onChange: () => void) => {
    if (typeof window === "undefined") return () => {};
    const mql = window.matchMedia(query);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  };

  const getSnapshot = () =>
    typeof window === "undefined" ? defaultValue : window.matchMedia(query).matches;

  const getServerSnapshot = () => defaultValue;

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Tailwind breakpoint helpers (min-width). Default to desktop on the server. */
export const useIsDesktop = () => useMediaQuery("(min-width: 640px)", true); // sm+
export const useIsTablet = () => useMediaQuery("(min-width: 768px)", true); // md+
export const useIsLargeScreen = () => useMediaQuery("(min-width: 1024px)", true); // lg+
