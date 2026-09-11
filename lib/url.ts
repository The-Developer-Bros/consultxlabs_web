/**
 * Shared application URL utility.
 *
 * Single source of truth for the app's base URL. Supports Netlify (current)
 * and Vercel (future) hosting with automatic env var detection.
 *
 * Resolution order:
 * 1. DEPLOY_PRIME_URL  — Netlify, non-production contexts only. Takes
 *    precedence deliberately: `NEXT_PUBLIC_APP_URL` is set with context
 *    `all` and pinned to the production domain, so without this a deploy
 *    preview resolves to production and calls production's API.
 * 2. NEXT_PUBLIC_APP_URL — explicit override (set in .env / hosting
 *    dashboard). `next.config.mjs` already rewrites this per deploy context
 *    at build time, so on Netlify the two agree; this order also covers
 *    callers running outside that build.
 * 3. URL               — auto-set by Netlify, the SITE's primary URL. Note
 *    this is production even on a preview build, hence its low rank.
 * 4. VERCEL_URL        — auto-set by Vercel without protocol.
 * 5. http://localhost:3000 — local dev fallback
 */
export function getAppUrl(): string {
  // Netlify sets CONTEXT to "production" | "deploy-preview" | "branch-deploy".
  // Anything but production should address itself, not the live site.
  if (
    process.env.CONTEXT &&
    process.env.CONTEXT !== "production" &&
    process.env.DEPLOY_PRIME_URL
  ) {
    return process.env.DEPLOY_PRIME_URL;
  }

  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL;
  }

  // Netlify auto-sets URL (includes protocol)
  if (process.env.URL) {
    return process.env.URL;
  }

  // Vercel auto-sets VERCEL_URL (no protocol)
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }

  return "http://localhost:3000";
}
