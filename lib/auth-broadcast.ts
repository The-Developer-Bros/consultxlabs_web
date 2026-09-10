/**
 * Cross-tab auth sync.
 *
 * BetterAuth's client only broadcasts a session change to other tabs on
 * sign-out / update-user / update-session (better-auth `client/config.mjs`),
 * never on sign-in — and OAuth/SSO complete via a full-page redirect with no
 * client fetch listener at all. So an already-open tab keeps showing
 * logged-out after you log in elsewhere until it next regains focus. We bridge
 * that gap by emitting our own login/logout ping; peer tabs refetch on receipt.
 *
 * Prefers BroadcastChannel and falls back to a `storage`-event ping for
 * browsers without it. SSR-safe (no-ops on the server). Best-effort throughout
 * — a sync failure must never break auth.
 */
export const AUTH_SYNC_CHANNEL = "familiarise.auth";

export type AuthSyncMessage = { type: "login" | "logout" };

// Last observed authed state, shared across tabs via localStorage. Lets a tab
// tell a genuine login (null/false -> true, including the OAuth/SSO full-page
// redirect) apart from a reload of an already-authed user, so a plain refresh
// no longer fires a synthetic broadcast that spams peer-tab refetches.
const AUTHED_FLAG_KEY = "familiarise.auth_authed";

// Display-only identity for the remembered shape, so the navbar can paint the
// real avatar and name on the first frame instead of a silhouette. Deliberately
// name + image ONLY: no id, no email, no role, no org. Nothing here may ever be
// used as an authorization signal — see `hooks/useRememberedAuth.ts`.
const AUTHED_IDENTITY_KEY = "familiarise.auth_identity";

export type AuthIdentity = { name: string | null; image: string | null };

export function readAuthedFlag(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const value = localStorage.getItem(AUTHED_FLAG_KEY);
    return value === null ? null : value === "true";
  } catch {
    return null;
  }
}

export function readAuthedIdentity(): AuthIdentity | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(AUTHED_IDENTITY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { name, image } = parsed as Partial<AuthIdentity>;
    return {
      name: typeof name === "string" ? name : null,
      image: typeof image === "string" ? image : null,
    };
  } catch {
    return null;
  }
}

/**
 * Single choke point for the remembered auth state. Writing `false` ALWAYS
 * removes the cached identity, so a shared or public device can never retain
 * the previous user's name and avatar: the flag and the identity cannot
 * disagree by construction. Every sign-out path in the app reaches this via the
 * wrapped `signOut` in `lib/auth-client.ts`, and `AuthSyncProvider` calls it
 * again on every resolved-null session.
 */
export function writeAuthedFlag(
  authed: boolean,
  identity?: AuthIdentity | null,
): void {
  if (typeof window === "undefined") return;
  try {
    // Clear before writing, never after: if the replacement write throws
    // (quota, Safari private mode) a clear-last order would leave the PREVIOUS
    // account's identity sitting next to a true flag, and the next pending
    // session would paint their name and avatar.
    localStorage.removeItem(AUTHED_IDENTITY_KEY);
    localStorage.setItem(AUTHED_FLAG_KEY, authed ? "true" : "false");
    if (authed && identity) {
      localStorage.setItem(AUTHED_IDENTITY_KEY, JSON.stringify(identity));
    }
  } catch {
    // Best-effort, but the invariant is not optional. Fall back to the
    // signed-out shape, which costs a skeleton frame and leaks nothing.
    try {
      localStorage.removeItem(AUTHED_IDENTITY_KEY);
      localStorage.setItem(AUTHED_FLAG_KEY, "false");
    } catch {
      // Storage is unavailable outright, so nothing was ever cached.
    }
  }
}

/** Sign-out-facing alias; the clear is the point, so say so at the call site. */
export function forgetAuthState(): void {
  writeAuthedFlag(false);
}

export function postAuthSync(message: AuthSyncMessage): void {
  if (typeof window === "undefined") return;
  try {
    if ("BroadcastChannel" in window) {
      const channel = new BroadcastChannel(AUTH_SYNC_CHANNEL);
      channel.postMessage(message);
      channel.close();
      return;
    }
  } catch {
    // fall through to the storage-event fallback
  }
  try {
    // A value change is what fires `storage` in peer tabs, so stamp each ping.
    localStorage.setItem(
      AUTH_SYNC_CHANNEL,
      JSON.stringify({ ...message, t: Date.now() }),
    );
  } catch {
    // best-effort — ignore
  }
}

export function subscribeAuthSync(
  handler: (message: AuthSyncMessage) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const cleanups: Array<() => void> = [];

  try {
    if ("BroadcastChannel" in window) {
      const channel = new BroadcastChannel(AUTH_SYNC_CHANNEL);
      const onMessage = (event: MessageEvent) =>
        handler(event.data as AuthSyncMessage);
      channel.addEventListener("message", onMessage);
      cleanups.push(() => {
        channel.removeEventListener("message", onMessage);
        channel.close();
      });
      // BroadcastChannel handles peer delivery — do NOT also listen for
      // `storage`. `postAuthSync` never writes the storage ping when a
      // channel exists, so the listener would be inert at best; at worst any
      // unrelated write to the sync key fires spurious refetch storms in
      // every tab.
      return () => cleanups.forEach((fn) => fn());
    }
  } catch {
    // ignore — storage fallback below still applies
  }

  // `storage` fires only in OTHER tabs of the same origin, which is exactly the
  // peer-tab signal we want; it also covers browsers without BroadcastChannel.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== AUTH_SYNC_CHANNEL || !event.newValue) return;
    try {
      handler(JSON.parse(event.newValue) as AuthSyncMessage);
    } catch {
      // ignore malformed payloads
    }
  };
  window.addEventListener("storage", onStorage);
  cleanups.push(() => window.removeEventListener("storage", onStorage));

  return () => cleanups.forEach((fn) => fn());
}
