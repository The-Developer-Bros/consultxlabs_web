import { withSentryConfig } from "@sentry/nextjs";
/** @type {import('next').NextConfig} */
const withBundleAnalyzer =
  process.env.ANALYZE === "true"
    ? (await import("@next/bundle-analyzer")).default({
        enabled: true,
        openAnalyzer: true,
      })
    : (config) => config;

/**
 * Content Security Policy — report-only by default.
 *
 * Why report-only first
 * ---------------------
 * A strict CSP can silently break Stream.io's call-widget script
 * injection or a Razorpay popup if any allow-list entry drifts. We
 * land in report-only so the dashboard surface stays functional while
 * we observe `Content-Security-Policy-Report-Only` violations at
 * `/api/csp-report` for a rollout window. Flip `ENABLE_CSP_ENFORCE=true`
 * once telemetry is clean to switch the header name to the enforcing
 * variant.
 *
 * Allow-list rationale
 * --------------------
 *   - `script-src` includes Razorpay's checkout CDN + Stripe.js +
 *     Stream.io + Sentry + Supabase + 'unsafe-inline'/'unsafe-eval'
 *     (Next.js still emits inline runtime chunks; Next 15 hashing
 *     lands in 16).
 *   - `connect-src` opens WSS for Stream + HTTPS for the four payment
 *     gateways + Sentry + Resend + Upstash. Anything new must be
 *     added here AND in the matching client.
 *   - `frame-src` allows Razorpay's + Stripe's checkout iframes; Razorpay
 *     serves the live checkout iframe from `api.razorpay.com`, not just
 *     `checkout.razorpay.com` (report-only violation on a real checkout).
 *   - `media-src` is the load-bearing entry for Stream call audio /
 *     video / recording playback.
 *
 * Stream.io does NOT run on getstream.io at runtime
 * -------------------------------------------------
 * `getstream.io` is the marketing/docs domain. The SDKs actually talk to
 * three separate domains, none of which `*.getstream.io` matches, so every
 * dashboard load was filing violation reports:
 *
 *   - `*.stream-io-api.com`   REST + the chat/video websockets
 *                             (`wss://video.stream-io-api.com`)
 *   - `*.stream-io-video.com` the edge-latency hint (`hint.…`) the client
 *                             fetches BEFORE a call to pick an SFU, then the
 *                             SFU edge itself
 *   - `*.stream-io-cdn.com`   recordings and chat attachments
 *
 * Confirmed against a real network log on a deploy preview, not inferred from
 * docs. `*.getstream.io` stays because Stream still serves some static assets
 * there and removing it is a separate, unobserved risk.
 *
 * Not added, deliberately: `worker-src`. Nothing in this app constructs a
 * Worker and the Stream background-filter/noise-cancellation add-ons (the
 * things that would need `blob:` workers and `wasm-unsafe-eval`) are not
 * installed. If those are ever enabled, this is the directive that will break
 * first, and `default-src 'self'` is what it will fall back to.
 */
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://checkout.razorpay.com https://js.stripe.com https://*.sentry.io https://*.getstream.io https://*.supabase.co",
  "connect-src 'self' https://*.getstream.io wss://*.getstream.io https://*.stream-io-api.com wss://*.stream-io-api.com https://*.stream-io-video.com wss://*.stream-io-video.com https://*.stream-io-cdn.com https://*.supabase.co https://*.upstash.io https://api.razorpay.com https://api.stripe.com https://*.sentry.io https://api.resend.com https://*.novu.co wss://*.novu.co",
  "img-src 'self' data: https: blob:",
  "media-src 'self' blob: https://*.getstream.io https://*.stream-io-cdn.com https://*.stream-io-api.com",
  "style-src 'self' 'unsafe-inline'",
  "frame-src 'self' https://checkout.razorpay.com https://api.razorpay.com https://js.stripe.com https://hooks.stripe.com",
  "font-src 'self' data:",
  "report-uri /api/csp-report",
].join("; ");

const CSP_HEADER_KEY =
  process.env.ENABLE_CSP_ENFORCE === "true"
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";

/** @type {Array<{ key: string; value: string }>} */
const securityHeaders = [
  // Prevent the page from being embedded in an iframe (clickjacking)
  { key: "X-Frame-Options", value: "DENY" },
  // Prevent browsers from MIME-sniffing a response away from the declared content-type
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Disable DNS prefetching to reduce information leakage
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // Only send origin when navigating to same origin; send nothing for cross-origin
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Restrict access to browser features not used by this app. camera +
  // microphone stay `self` for Stream.io call surfaces; payment is locked
  // to none because Razorpay does its own iframe-scoped grant.
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(self), geolocation=(), payment=()",
  },
  // HSTS: force HTTPS for two years + preload-list eligibility. Safe to
  // ship — Netlify + Vercel both serve all production traffic over TLS.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // CSP (report-only by default; flipped to enforce via env flag — see
  // CSP_HEADER_KEY above). Pre-req for any large-customer security review.
  { key: CSP_HEADER_KEY, value: CSP_DIRECTIVES },
];

/**
 * The app's own origin, resolved at BUILD time.
 *
 * `NEXT_PUBLIC_APP_URL` is set on Netlify with context `all`, pinned to
 * https://familiarisenow.com. Because `NEXT_PUBLIC_*` is inlined into the
 * client bundle, every deploy preview shipped a bundle whose auth client
 * called PRODUCTION's `/api/auth/*`. The browser blocked it on CORS, which is
 * the only reason previews failed loudly rather than quietly authenticating
 * against production and mutating real data.
 *
 * Netlify sets `CONTEXT` (production | deploy-preview | branch-deploy) and
 * `DEPLOY_PRIME_URL` (this deploy's own origin) on every build. Off
 * production we prefer the per-deploy URL, so a preview talks to itself.
 *
 * This has to happen here rather than as an env var: Netlify env values are
 * literal strings — it does NOT expand `$DEPLOY_PRIME_URL` inside a value —
 * and `NEXT_PUBLIC_*` is baked at build, so a runtime fallback would come too
 * late for the client bundle.
 */
const RESOLVED_APP_URL =
  process.env.CONTEXT && process.env.CONTEXT !== "production"
    ? (process.env.DEPLOY_PRIME_URL ?? process.env.NEXT_PUBLIC_APP_URL)
    : process.env.NEXT_PUBLIC_APP_URL;

const nextConfig = {
  // Origin-dependent values are recomputed per deploy context — see
  // RESOLVED_APP_URL above. Listing them here overrides whatever the Netlify
  // dashboard injected, for the build only.
  env: {
    ...(RESOLVED_APP_URL
      ? {
          NEXT_PUBLIC_APP_URL: RESOLVED_APP_URL,
          BETTER_AUTH_URL: RESOLVED_APP_URL,
          // BetterAuth rejects any Origin not on this list. A preview must
          // trust its own origin or every auth call 403s.
          BETTER_AUTH_TRUSTED_ORIGINS: [
            ...new Set(
              [
                ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",") ?? []),
                RESOLVED_APP_URL,
              ]
                .map((s) => s.trim())
                .filter(Boolean),
            ),
          ].join(","),
        }
      : {}),
  },
  // Only the Netlify deploy build OOM'd at the 4GB heap re-running ESLint + tsc.
  // Skip them THERE (NETLIFY=true is set in Netlify's build env) to drop that memory
  // hog — CI gates both independently anyway (ci.yaml runs `npx tsc --noEmit` +
  // `npx eslint .` as their own steps). Local `npm run build` and CI's own build keep
  // the checks on, so nothing loses its safety net off-Netlify. (#932)
  eslint: { ignoreDuringBuilds: !!process.env.NETLIFY },
  typescript: { ignoreBuildErrors: !!process.env.NETLIFY },
  // Reduce Webpack memory usage during builds (Next.js 15+, low-risk experimental)
  experimental: {
    webpackMemoryOptimizations: true,
    // Only packages Next does NOT already optimize by default. Its built-in
    // list covers lucide-react, recharts and date-fns among others, so listing
    // those was inert config that read as if it were doing something.
    // https://nextjs.org/docs/app/api-reference/config/next-config-js/optimizePackageImports
    optimizePackageImports: [
      "framer-motion",
      "@stream-io/video-react-sdk",
      "stream-chat-react",
      "@radix-ui/react-icons",
      // Imported by components/notifications/NotificationInbox.tsx and not in
      // the default list.
      "@novu/react",
      "@novu/nextjs",
    ],
    // Next 15 defaults page segments to 0, which refetches RSC on every nav; this lets the client router cache hold payloads ~30s between navs.
    staleTimes: { dynamic: 30, static: 180 },
  },

  // This tells Next.js to explicitly process these packages during the build, which should resolve the module format conflict.
  // NOTE: date-fns is now 4.1.0 and ships an exports map, so this is likely a
  // leftover from the v2/v3 era — and transpiling a package may defeat Next's
  // built-in optimizePackageImports handling for it (45 files import date-fns).
  // Left in place deliberately: the claim above is unverified either way, and
  // confirming it needs `npm run build:analyze`, not reasoning.
  transpilePackages: ["date-fns"],

  // #1244 — the OpenNext server-handler function blew past Netlify's hard
  // 250MB per-function cap. The file tracer was pulling the entire BUILD
  // toolchain into every deployment (typescript, esbuild binaries, webpack +
  // its graph, terser): none of it is loadable at request time. Excluding it
  // sheds ~40MB with zero runtime surface.
  outputFileTracingExcludes: {
    "*": [
      "node_modules/typescript/**",
      "node_modules/@esbuild/**",
      "node_modules/esbuild/**",
      "node_modules/webpack/**",
      "node_modules/webpack-sources/**",
      "node_modules/watchpack/**",
      "node_modules/tapable/**",
      "node_modules/@xtuc/**",
      "node_modules/enhanced-resolve/**",
      "node_modules/terser/**",
      "node_modules/terser-webpack-plugin/**",
      "node_modules/schema-utils/**",
      "node_modules/jest-worker/**",
    ],
  },

  // #1365 — the consumer invoice and credit-note PDFs register a Devanagari
  // face from `public/fonts/`. The tracer follows imports, and a font read at
  // render time through `path.join(process.cwd(), …)` is invisible to it, so
  // the file would be absent from the deployed function and every Hindi or
  // Marathi buyer name would render as boxes. Name the routes explicitly.
  //
  // #1468 — the same blind spot applies to `react/jsx-runtime`. The statutory
  // documents create their elements through it deliberately outside the
  // bundler (lib/pdf/react-runtime/jsx-runtime.ts), which the tracer cannot
  // see, and the only traced import of `react` is the reconciler's, which
  // reaches the package root rather than that entrypoint. Ship the package.
  outputFileTracingIncludes: {
    "/api/payments/[paymentId]/invoice/pdf": [
      "./public/fonts/**",
      "./node_modules/react/**",
    ],
    "/api/payments/[paymentId]/credit-note/[creditNoteId]/pdf": [
      "./public/fonts/**",
      "./node_modules/react/**",
    ],
    "/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pdf": [
      "./node_modules/react/**",
    ],
    "/api/organizations/[orgId]/billing-account/credit-notes/[creditNoteId]/pdf":
      ["./node_modules/react/**"],
  },

  // Prevent pg (node-postgres) and related packages from being bundled into client-side code
  // These are server-only dependencies used by @prisma/adapter-pg.
  //
  // `@react-pdf/renderer` is also in Next's own built-in external list, so
  // listing it here changes nothing — it is external either way, and that is
  // what forces lib/pdf to resolve its JSX runtime past the bundler (#1468).
  serverExternalPackages: [
    "pg",
    "@prisma/adapter-pg",
    "pg-pool",
    "pg-connection-string",
    "@react-pdf/renderer",
    "razorpay",
    "stripe",
    "resend",
    "bcrypt",
    "@stream-io/node-sdk",
    "libsodium-wrappers",
  ],

  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      {
        hostname: "lh3.googleusercontent.com",
      },
      {
        hostname: "*.supabase.co",
      },
      {
        hostname: "avatars.githubusercontent.com",
      },
      {
        hostname: "picsum.photos",
      },
      {
        hostname: "cdn.jsdelivr.net",
      },
      {
        hostname: "upload.wikimedia.org",
      },
      {
        hostname: "img.logo.dev",
      },
    ],
  },

  // The bundle-size framing this carried as a bare `true` was wrong, and it cost
  // two investigations. SWC applies this transform to the SERVER layer as well as
  // the client — Next offers no client-only scoping (vercel/next.js#48410 is
  // unresolved) — so `true` deleted every one of ~1,110 server-side diagnostics
  // from the deployed function. Proven, not inferred: a console.warn at Prisma
  // client construction produced ZERO log lines on preview 1118 across two
  // confirmed module loads, while third-party output in the same window survived
  // (node_modules is not compiled by SWC). #1122.
  //
  // `error` and `warn` are the levels a deliberate diagnostic uses, so they stay.
  // `log` is the chatty one and keeps being stripped, which is the whole of the
  // bundle saving the original comment was after. Note this cannot be recovered
  // with Sentry's consoleLoggingIntegration: that patches globalThis.console at
  // runtime, and this deletes the call expressions at compile time.
  compiler: {
    removeConsole:
      process.env.NODE_ENV === "production"
        ? { exclude: ["error", "warn"] }
        : false,
  },

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default withSentryConfig(withBundleAnalyzer(nextConfig), {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "practitionist",

  project: "familiarise_web",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // #900 — the build/deploy must NOT fail because the Sentry source-map upload
  // failed (e.g. an expired/invalid SENTRY_AUTH_TOKEN on Netlify). With an
  // errorHandler the Sentry plugin logs and CONTINUES instead of exiting
  // non-zero; source maps just won't upload until the token is rotated, but the
  // build always succeeds. (next build succeeds locally — the upload only runs
  // where the token is set, so this surfaced as a Netlify-only build failure.)
  errorHandler: (err) => {
    console.warn(
      "[sentry] source-map upload step failed (non-fatal):",
      err?.message ?? err,
    );
  },

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Uncomment to route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  // tunnelRoute: "/monitoring",

  webpack: {
    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
