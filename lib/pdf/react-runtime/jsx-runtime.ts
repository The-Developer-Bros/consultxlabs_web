/**
 * The JSX runtime the statutory-document components compile against. (#1468)
 *
 * `@react-pdf/renderer` sits in Next's built-in `serverExternalPackages` list,
 * so the deployed function loads it through Node's resolver, and with it
 * `@react-pdf/reconciler`, which picks one of three bundled reconcilers by
 * reading `React.version`. That lands on this project's userland React. App
 * code in the `rsc` layer is compiled against Next's vendored React instead.
 * When the two disagree the reconciler does not recognise the elements it is
 * handed and the render dies with React error #31. Resolving the runtime the
 * same way the reconciler resolves React keeps both sides of that boundary on
 * one React.
 */
import { nodeRequire } from "./node-require";

const runtime = nodeRequire(
  "react/jsx-runtime",
) as typeof import("react/jsx-runtime");

export const Fragment = runtime.Fragment;
export const jsx = runtime.jsx;
export const jsxs = runtime.jsxs;

export type { JSX } from "react/jsx-runtime";
