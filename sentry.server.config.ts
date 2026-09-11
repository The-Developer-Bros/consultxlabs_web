// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
//
// Init config lives in sentry.shared.config.ts (shared across runtimes — #913).

import { initSentry } from "./sentry.shared.config";

initSentry();
