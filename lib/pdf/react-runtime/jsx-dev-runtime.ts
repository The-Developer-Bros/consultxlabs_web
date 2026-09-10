/**
 * Development twin of ./jsx-runtime — the SWC transform emits `jsxDEV` calls
 * against this specifier whenever the build is not a production one. Same
 * reason, same resolution. (#1468)
 */
import { nodeRequire } from "./node-require";

const runtime = nodeRequire(
  "react/jsx-dev-runtime",
) as typeof import("react/jsx-dev-runtime");

export const Fragment = runtime.Fragment;
export const jsxDEV = runtime.jsxDEV;

export type { JSX } from "react/jsx-dev-runtime";
