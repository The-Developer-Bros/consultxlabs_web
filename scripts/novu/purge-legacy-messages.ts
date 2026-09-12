/**
 * Delete the in-app messages the retired legacy workflows rendered.
 *
 *   npm run novu:purge-legacy              count only
 *   npm run novu:purge-legacy -- --apply   delete
 *
 * Novu stores each message's rendered text at send time, so the blank
 * "has been updated to:" rows and the UUID-bearing "New support ticket"
 * rows stay in every inbox after the templates are replaced. A message is
 * selected by `templateIdentifier` — an EVENT id, which only a legacy
 * workflow ever carried; the families write their own ids — so nothing a
 * family rendered can match. Production operation: local and production
 * share the Development environment.
 */

import { Novu } from "@novu/api";
import { EVENT_FAMILY } from "../../lib/novu/templates";

const APPLY = process.argv.includes("--apply");
const PAGE = 100;

async function main() {
  const secretKey = process.env.NOVU_SECRET_KEY;
  if (!secretKey) throw new Error("NOVU_SECRET_KEY is not set");
  const novu = new Novu({ secretKey });
  const legacyIds = new Set<string>(Object.keys(EVENT_FAMILY));

  const targets: Array<{ id: string; template: string }> = [];
  const seen = new Map<string, number>();
  for (let page = 0; ; page += 1) {
    const { result } = await novu.messages.retrieve({
      channel: "in_app",
      limit: PAGE,
      page,
    });
    const rows = result.data as Array<{
      id?: string;
      templateIdentifier?: string;
    }>;
    for (const m of rows) {
      const template = m.templateIdentifier ?? "";
      seen.set(template, (seen.get(template) ?? 0) + 1);
      if (m.id && legacyIds.has(template)) {
        targets.push({ id: m.id, template });
      }
    }
    if (!result.hasMore || rows.length === 0) break;
  }

  console.log("in-app messages by template:");
  for (const [t, n] of [...seen.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(
      `  ${String(n).padStart(5)}  ${t}${legacyIds.has(t) ? "  (legacy — purge)" : ""}`,
    );
  }
  console.log(
    `\n${targets.length} to delete${APPLY ? "" : " (dry run; pass --apply)"}`,
  );
  if (!APPLY) return;

  let done = 0;
  for (const t of targets) {
    await novu.messages.delete(t.id);
    done += 1;
    if (done % 25 === 0) console.log(`  deleted ${done}/${targets.length}`);
  }
  console.log(`deleted ${done}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
