"use client";

import { useQuery } from "@tanstack/react-query";

/** An active row of the admin-authored `Announcement` table (`GET /api/announcements`). */
export interface ActiveAnnouncement {
  id: string;
  title: string;
  content: string;
  backgroundColor?: string | null;
  textColor?: string | null;
  linkUrl?: string | null;
  linkText?: string | null;
  startDate?: string | null;
  createdAt?: string;
}

async function fetchActiveAnnouncements(): Promise<ActiveAnnouncement[]> {
  const response = await fetch("/api/announcements");
  if (!response.ok) throw new Error("Failed to fetch announcements");
  const result = await response.json();
  return result.success ? result.data : [];
}

/**
 * The announcements every surface shows — the site-wide banner and the staff
 * home card share this one cache entry, so a card can never disagree with
 * the banner above it.
 */
export function useActiveAnnouncements() {
  return useQuery({
    queryKey: ["announcements"],
    queryFn: fetchActiveAnnouncements,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
