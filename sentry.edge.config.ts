// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
//
// Init config lives in sentry.shared.config.ts (shared across runtimes — #913).

import { initSentry } from "./sentry.shared.config";

initSentry();
