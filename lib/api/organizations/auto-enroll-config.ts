/**
 * Wall-clock budget for the auto-enroll batch loop (wave-9 #1230). Netlify
 * hard-kills synchronous functions at 60s; 45s leaves headroom for the
 * response and a safety margin over the worst per-entry retry chain.
 *
 * Lives here rather than in route.ts because Next.js route files may only
 * export handlers + segment config — an extra const export fails the build's
 * route type check ("does not match the required types of a Next.js Route").
 */
export const AUTO_ENROLL_BATCH_DEADLINE_MS = 45_000;
