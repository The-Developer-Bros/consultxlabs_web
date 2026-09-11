// Single source of truth for Next data-cache tags, so a cached read and the
// write paths that must invalidate it can't drift apart. (#932)
export const ANNOUNCEMENTS_TAG = "announcements";
