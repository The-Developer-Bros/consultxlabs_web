"use client";

import { usePathname } from "next/navigation";

import { needsHeaderSpacer } from "@/lib/navigation/public-chrome";

/**
 * HeaderSpacer - Creates vertical space to account for fixed Navbar and AnnouncementBar
 *
 * This component prevents page content from being hidden behind the fixed header elements.
 * It uses CSS custom properties (--header-height) set dynamically by the AnnouncementBarProvider
 * and responsive media queries in globals.css, so it adapts automatically to:
 * - Different screen sizes (mobile, tablet, desktop)
 * - Orientation changes (portrait, landscape)
 * - Announcement bar visibility (present, dismissed, wrapping text)
 * - Device safe areas (notch, Dynamic Island)
 *
 * Which routes need a spacer is derived in lib/navigation/public-chrome.ts
 * rather than listed locally — the local list had already drifted from the
 * Navbar's dark-hero list, which is what put a white spacer band under the
 * transparent nav on the organisations directory.
 */
const HeaderSpacer = () => {
  const pathname = usePathname();

  if (!needsHeaderSpacer(pathname)) {
    return null;
  }

  return (
    <div
      className="w-full"
      style={{ height: "var(--header-height)" }}
      aria-hidden="true"
    />
  );
};

export default HeaderSpacer;
