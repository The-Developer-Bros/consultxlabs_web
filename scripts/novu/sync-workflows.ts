/**
 * Write lib/novu/templates to the Novu environment NOVU_SECRET_KEY points at.
 *
 *   npm run novu:sync -- --dry-run      print the plan, write nothing
 *   npm run novu:check                  exit 1 if anything would change
 *   npm run novu:sync -- --only <id>    one family
 *   npm run novu:sync                   apply
 *
 * One workflow per FAMILY (lib/novu/templates/families.ts); the 19 legacy
 * workflows carry event ids as their workflow id and are retired first, since
 * the plan's 20-workflow cap is what forced the families. Both local and
 * production use the Development environment, so an apply is a production
 * operation — run --dry-run first, and never from CI.
 */

import { Novu } from "@novu/api";
import type {
  CreateWorkflowDto,
  InAppStepUpsertDto,
  UpdateWorkflowDto,
  WorkflowResponseDto,
} from "@novu/api/models/components";
import { NovuError } from "@novu/api/models/errors";
import {
  EVENT_FAMILY,
  FAMILIES,
  IN_APP_STEP_NAME,
  toFamilyDto,
} from "../../lib/novu/templates";

type Plan =
  | { action: "create"; id: string }
  | { action: "update"; id: string; changed: string[] }
  | { action: "unchanged"; id: string }
  | { action: "retire"; id: string; reason: string }
  | { action: "foreign"; id: string };

/** The plan's ceiling on live workflows per environment (Free and Pro). */
const WORKFLOW_CAP = 20;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const CHECK = args.includes("--check");
const ONLY =
  args.indexOf("--only") >= 0 ? args[args.indexOf("--only") + 1] : undefined;
if (args.includes("--only") && (!ONLY || ONLY.startsWith("--"))) {
  // A bare `--only` would otherwise widen to a full sync, retirements included.
  console.error("--only needs a family id");
  process.exit(2);
}

function isNotFound(err: unknown): boolean {
  return err instanceof NovuError && err.statusCode === 404;
}

function inAppControls(live: WorkflowResponseDto): Record<string, unknown> {
  const step = live.steps.find((s) => s.type === "in_app");
  return (step?.controlValues ?? {}) as Record<string, unknown>;
}

/** Fields whose live value must equal the manifest's. */
function diff(live: WorkflowResponseDto, want: CreateWorkflowDto): string[] {
  const changed: string[] = [];
  if (live.name !== want.name) changed.push("name");
  if (live.active !== (want.active ?? true)) changed.push("active");
  if ((live.description ?? "") !== (want.description ?? "")) {
    changed.push("description");
  }
  const liveTags = [...(live.tags ?? [])].sort().join(",");
  if (liveTags !== [...(want.tags ?? [])].sort().join(",")) {
    changed.push("tags");
  }
  if (live.steps.length !== 1 || live.steps[0]?.type !== "in_app") {
    changed.push("steps");
    return changed;
  }
  const liveControls = inAppControls(live);
  const wantControls = want.steps[0]!.controlValues as Record<string, unknown>;
  for (const key of ["subject", "body", "redirect", "skip"]) {
    if (
      JSON.stringify(liveControls[key] ?? null) !==
      JSON.stringify(wantControls[key] ?? null)
    ) {
      changed.push(`in_app.${key}`);
    }
  }
  return changed;
}

async function planFamily(novu: Novu, want: CreateWorkflowDto): Promise<Plan> {
  const id = want.workflowId;
  let live: WorkflowResponseDto;
  try {
    live = (await novu.workflows.get(id)).result;
  } catch (err) {
    if (isNotFound(err)) return { action: "create", id };
    throw err;
  }
  const changed = diff(live, want);
  return changed.length === 0
    ? { action: "unchanged", id }
    : { action: "update", id, changed };
}

/** Everything live that is not a family: ours to retire, or someone else's. */
async function planOthers(novu: Novu): Promise<Plan[]> {
  const familyIds = new Set<string>(FAMILIES.map((f) => f.id));
  const eventIds = new Set<string>(Object.keys(EVENT_FAMILY));
  const { result } = await novu.workflows.list({ limit: 100 });
  return result.workflows
    .filter((w) => !familyIds.has(w.workflowId))
    .map((w) =>
      eventIds.has(w.workflowId)
        ? {
            action: "retire" as const,
            id: w.workflowId,
            reason: `${w.origin} workflow for an event now in "${EVENT_FAMILY[w.workflowId as keyof typeof EVENT_FAMILY]}"`,
          }
        : { action: "foreign" as const, id: w.workflowId },
    );
}

async function apply(novu: Novu, p: Plan, want?: CreateWorkflowDto) {
  switch (p.action) {
    case "unchanged":
    case "foreign":
      return;
    case "retire":
      await novu.workflows.delete(p.id);
      return;
    case "create":
      await novu.workflows.create(want!);
      return;
    case "update": {
      // In place, keeping the live step's id so its history survives.
      const live = (await novu.workflows.get(p.id)).result;
      const liveStep = live.steps.find((s) => s.type === "in_app");
      const step = want!.steps[0] as InAppStepUpsertDto;
      const update: UpdateWorkflowDto = {
        ...want!,
        origin: "novu-cloud",
        preferences: live.preferences.user
          ? { user: live.preferences.user }
          : {},
        steps: [
          {
            ...step,
            name: IN_APP_STEP_NAME,
            ...(liveStep ? { id: liveStep.id, stepId: liveStep.stepId } : {}),
          },
        ],
      };
      await novu.workflows.update(update, p.id);
    }
  }
}

async function main() {
  const secretKey = process.env.NOVU_SECRET_KEY;
  if (!secretKey) throw new Error("NOVU_SECRET_KEY is not set");
  const novu = new Novu({ secretKey });

  const families = FAMILIES.filter((f) => !ONLY || f.id === ONLY);
  if (families.length === 0) throw new Error(`no family matches ${ONLY}`);

  // Retirements go first: the cap counts live workflows, so a create before
  // the deletes would fail on a full environment.
  const plans: Array<{ p: Plan; want?: CreateWorkflowDto }> = ONLY
    ? []
    : (await planOthers(novu)).map((p) => ({ p }));
  for (const f of families) {
    const want = toFamilyDto(f);
    plans.push({ p: await planFamily(novu, want), want });
  }

  const pending = plans.filter(
    ({ p }) => p.action !== "unchanged" && p.action !== "foreign",
  );
  for (const { p } of plans) {
    const detail =
      p.action === "update"
        ? ` (${p.changed.join(", ")})`
        : p.action === "retire"
          ? ` (${p.reason})`
          : p.action === "foreign"
            ? " (not in the manifest — left alone)"
            : "";
    console.log(`${p.action.padEnd(10)} ${p.id}${detail}`);
  }
  console.log(
    `\n${plans.length} live+wanted: ${pending.length} to change, ${plans.length - pending.length} unchanged`,
  );

  if (CHECK) {
    if (pending.length > 0) {
      console.error("novu:check — the environment does not match the manifest");
      process.exit(1);
    }
    return;
  }
  if (DRY_RUN || pending.length === 0) return;

  // The cap counts live workflows, so a retirement must precede a create on
  // a full environment — but only ONE at a time, so a create that fails
  // leaves at most one legacy row gone, and a rerun completes the rest.
  // Everything is idempotent: get→update|create, and a retired id is gone.
  const retirements = pending.filter(({ p }) => p.action === "retire");
  const writes = pending.filter(({ p }) => p.action !== "retire");
  let live = (await novu.workflows.list({ limit: 100 })).result.totalCount;
  const run = async (item: { p: Plan; want?: CreateWorkflowDto }) => {
    process.stdout.write(`applying ${item.p.action} ${item.p.id} … `);
    await apply(novu, item.p, item.want);
    console.log("done");
  };
  for (const w of writes) {
    if (w.p.action === "create") {
      while (live >= WORKFLOW_CAP && retirements.length > 0) {
        await run(retirements.shift()!);
        live -= 1;
      }
      await run(w);
      live += 1;
    } else {
      await run(w);
    }
  }
  for (const r of retirements) await run(r);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
