/**
 * The `require` that reaches Node's resolver rather than the bundler's.
 *
 * Webpack rewrites `__non_webpack_require__` to a bare `require` in the
 * emitted CommonJS chunk — the same `require` it already uses to pull in the
 * packages listed as server externals, so it is Node's own. Outside a webpack
 * build (Jest, a `tsx` script) the identifier does not exist and the guard
 * falls through to the enclosing module's `require`, which is the same
 * resolver again. That is the whole point: one resolver, one React. (#1468)
 *
 * The fallback deliberately goes through `module.require` rather than a bare
 * `require`, which webpack would read as a request it cannot statically
 * extract and turn into a critical-dependency warning plus a context module.
 */
declare const __non_webpack_require__: (id: string) => unknown;

export const nodeRequire: (id: string) => unknown =
  typeof __non_webpack_require__ === "function"
    ? __non_webpack_require__
    : module.require.bind(module);
