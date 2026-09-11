/**
 * Simple in-memory caching utilities for Stream operations
 * Reduces redundant API calls for frequently accessed data
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Generic TTL cache for storing temporary data.
 * Supports an optional max size to prevent unbounded growth
 * in long-running server processes.
 */
class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private defaultTTL: number;
  private maxSize: number;

  constructor(defaultTTLMs: number = 60000, maxSize: number = Infinity) {
    this.defaultTTL = defaultTTLMs;
    this.maxSize = maxSize;
  }

  /**
   * Get a value from cache
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.value;
  }

  /**
   * Set a value in cache
   */
  set(key: string, value: T, ttlMs?: number): void {
    // Evict if at capacity (cleanup expired first, then evict oldest)
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.cleanup();
      if (this.cache.size >= this.maxSize) {
        // Evict the oldest entry (first key in insertion order)
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== undefined) this.cache.delete(firstKey);
      }
    }

    const expiresAt = Date.now() + (ttlMs ?? this.defaultTTL);
    this.cache.set(key, { value, expiresAt });
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Delete a specific key
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Clean up expired entries
   */
  cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    this.cache.forEach((entry, key) => {
      if (now > entry.expiresAt) {
        keysToDelete.push(key);
      }
    });

    keysToDelete.forEach((key) => this.cache.delete(key));
  }

  /**
   * Get current cache size
   */
  get size(): number {
    return this.cache.size;
  }
}

// Cache instances for different purposes

/**
 * Cache for tracking users that have been synced to Stream
 * TTL: 5 minutes - users don't need to be re-synced frequently
 */
export const userSyncCache = new TTLCache<boolean>(5 * 60 * 1000, 1000);

/**
 * Cache for channel existence checks
 * TTL: 2 minutes - channels rarely get deleted
 */
export const channelExistsCache = new TTLCache<boolean>(2 * 60 * 1000, 2000);

/**
 * Cache for user-to-channel membership
 * TTL: 1 minute - membership can change more frequently
 */
export const membershipCache = new TTLCache<boolean>(60 * 1000, 5000);

/**
 * Track users who have completed initial sync in this process.
 *
 * #1134 P1-18 — this was a plain `Set<string>` that nothing ever evicted:
 * "cleared only on server restart" is a memory leak with a nicer name. At 100k
 * users a warm instance retains 100k strings and grows monotonically. It is
 * also per-process, so on serverless it was doing very little work for that
 * cost anyway.
 *
 * Now bounded with the same FIFO eviction as the TTL caches. Evicting an entry
 * early is harmless: the only consequence is that one user re-runs a sync that
 * is already idempotent.
 */
const MAX_TRACKED_SYNCED_USERS = 10_000;

class BoundedSet {
  private readonly items = new Set<string>();

  constructor(private readonly max: number) {}

  add(value: string): void {
    // Re-inserting refreshes recency, so a hot user is not evicted by churn.
    this.items.delete(value);
    this.items.add(value);
    if (this.items.size > this.max) {
      const oldest = this.items.values().next();
      if (!oldest.done) this.items.delete(oldest.value);
    }
  }

  has(value: string): boolean {
    return this.items.has(value);
  }

  delete(value: string): boolean {
    return this.items.delete(value);
  }

  clear(): void {
    this.items.clear();
  }

  get size(): number {
    return this.items.size;
  }
}

export const initialSyncCompletedUsers = new BoundedSet(
  MAX_TRACKED_SYNCED_USERS,
);

/**
 * Mark a user as synced to Stream
 */
export function markUserSynced(userId: string): void {
  userSyncCache.set(`user:${userId}`, true);
}

/**
 * Check if a user has been synced recently
 */
export function isUserSynced(userId: string): boolean {
  return userSyncCache.has(`user:${userId}`);
}

/**
 * Mark a channel as existing
 */
export function markChannelExists(
  channelType: string,
  channelId: string,
): void {
  channelExistsCache.set(`${channelType}:${channelId}`, true);
}

/**
 * Check if a channel exists (from cache)
 */
export function isChannelCached(
  channelType: string,
  channelId: string,
): boolean | undefined {
  return channelExistsCache.get(`${channelType}:${channelId}`);
}

/**
 * Mark user as member of channel
 */
export function markMembership(
  channelId: string,
  userId: string,
  isMember: boolean,
): void {
  membershipCache.set(`${channelId}:${userId}`, isMember);
}

/**
 * Check if user is member of channel (from cache)
 */
export function getMembershipCached(
  channelId: string,
  userId: string,
): boolean | undefined {
  return membershipCache.get(`${channelId}:${userId}`);
}

/**
 * Clear sync completion marker for a specific user.
 * Forces a full re-sync on the next call to syncUserEventChannels.
 */
export function clearSyncCacheForUser(userId: string): void {
  initialSyncCompletedUsers.delete(userId);
}

/**
 * Clear all Stream-related caches
 */
export function clearAllStreamCaches(): void {
  userSyncCache.clear();
  channelExistsCache.clear();
  membershipCache.clear();
  initialSyncCompletedUsers.clear();
}

/**
 * Run cleanup on all caches (removes expired entries)
 */
export function cleanupStreamCaches(): void {
  userSyncCache.cleanup();
  channelExistsCache.cleanup();
  membershipCache.cleanup();
}

// Export the TTLCache class for custom cache needs
export { TTLCache };
