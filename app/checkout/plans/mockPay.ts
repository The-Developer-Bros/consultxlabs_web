/**
 * Mock-payment gating for dev + Netlify previews only — NEVER production.
 *
 * Thin, bundle-safe client alias over the canonical server-side check in
 * `@/lib/payments/operations/mock` (`shouldEnableMockPayments`). The pages and
 * the checkout route use this name for one consistent mood:
 *
 * - Server (route handlers): `CONTEXT` (deploy-preview / branch-deploy) is
 *   readable server-side, so preview builds gate directly on it.
 * - Client (Mock Pay button render): `CONTEXT` is NOT inlined into client
 *   bundles (only `NEXT_PUBLIC_*` vars are). `netlify.toml` therefore exports
 *   `NEXT_PUBLIC_MOCK_PAYMENTS_ENABLED=true` under `[context.deploy-preview]`
 *   and `[context.branch-deploy]`, which Next inlines at preview build time.
 *
 * `NODE_ENV === "development"` is the local shortcut and always wins.
 */
export { shouldEnableMockPayments as isMockPayEnabled } from "@/lib/payments/operations/mock";
