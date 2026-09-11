// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
//
// Init config lives in sentry.shared.config.ts (shared across runtimes — #913).

import * as Sentry from "@sentry/nextjs";
import { initSentry } from "./sentry.shared.config";

initSentry();

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
