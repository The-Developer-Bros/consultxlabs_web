import fs from "fs";
import path from "path";

/**
 * Shared workflow-introspection helpers.
 *
 * #1270 — `entrypointOf` was copied verbatim into both the cron-lock registry
 * guard and the import-env guard. Two copies of a parser that has to track how
 * this repo invokes tsx will drift the moment a third invocation style appears,
 * and the duplication tripped the quality gate. One copy, two callers.
 */

export const ROOT = path.resolve(__dirname, "..", "..");

export function read(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Extract the `.ts` file a workflow actually executes. */
export function entrypointOf(workflowSrc: string): string | null {
  const tsx = workflowSrc.match(/tsx@[\d.]+\s+([^\s"']+\.ts)/);
  if (tsx) return tsx[1];

  // S6505-hardened variant (#1234): workflows running the locally-installed
  // binary directly instead of on-demand npx resolution.
  const localTsx = workflowSrc.match(
    /node_modules\/\.bin\/tsx\s+([^\s"']+\.ts)/,
  );
  if (localTsx) return localTsx[1];

  const npmScript = workflowSrc.match(/run:\s*npm run ([a-z0-9:_-]+)/);
  if (npmScript) {
    const pkg = JSON.parse(read(path.join(ROOT, "package.json")) ?? "{}");
    const cmd: string = pkg.scripts?.[npmScript[1]] ?? "";
    const hit = cmd.match(/([^\s"']+\.ts)/);
    return hit ? hit[1] : null;
  }
  return null;
}
