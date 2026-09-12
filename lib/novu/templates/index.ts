import type { CreateWorkflowDto } from "@novu/api/models/components";
import { B2C_TEMPLATES } from "./b2c";
import { ORG_TEMPLATES } from "./org";
import { inAppSkipRule } from "./conditions";
import { FAMILIES, familyOf, type Family, type FamilyId } from "./families";
import type { NovuWorkflowId, WorkflowTemplate } from "./types";

export type {
  InAppTemplate,
  PreferenceCategory,
  WorkflowTemplate,
} from "./types";
export { EVENT_FAMILY, FAMILIES, familyOf, toWire } from "./families";
export type { Family, FamilyId } from "./families";

export const NOVU_WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  ...B2C_TEMPLATES,
  ...ORG_TEMPLATES,
];

export function templateFor(
  workflowId: NovuWorkflowId,
): WorkflowTemplate | undefined {
  return NOVU_WORKFLOW_TEMPLATES.find((t) => t.workflowId === workflowId);
}

export function templatesInFamily(id: FamilyId): WorkflowTemplate[] {
  return NOVU_WORKFLOW_TEMPLATES.filter((t) => familyOf(t.workflowId) === id);
}

/** The step name is the key the sync uses to match the live step. */
export const IN_APP_STEP_NAME = "In-app";

/**
 * One Liquid `case` over `payload.event`, on a single line so no branch
 * leaks whitespace into the rendered text.
 */
function caseOverEvents(
  templates: WorkflowTemplate[],
  pick: (t: WorkflowTemplate) => string | undefined,
): string {
  const branches = templates
    .map((t) => [t.workflowId, pick(t)] as const)
    .filter(([, text]) => !!text)
    .map(([event, text]) => `{% when "${event}" %}${text}`)
    .join("");
  return branches ? `{% case payload.event %}${branches}{% endcase %}` : "";
}

/**
 * The exact document the sync writes for a family. Tags carry the category
 * so the Inbox can filter on it; `payloadSchema` stays open because the
 * app's types are the schema (#1442 — a strict schema rejected a valid
 * trigger once).
 */
export function toFamilyDto(family: Family): CreateWorkflowDto {
  const members = templatesInFamily(family.id);
  if (members.length === 0) {
    throw new Error(`Novu family "${family.id}" has no events`);
  }
  const subject = caseOverEvents(members, (t) => t.inApp.subject);
  const redirectUrl = caseOverEvents(members, (t) => t.inApp.redirectUrl);
  return {
    workflowId: family.id,
    name: family.name,
    description: `${family.description} Events: ${members
      .map((t) => t.workflowId)
      .join(", ")}.`,
    tags: family.category ? [family.category] : [],
    active: true,
    validatePayload: false,
    source: "dashboard",
    steps: [
      {
        name: IN_APP_STEP_NAME,
        type: "in_app",
        controlValues: {
          ...(subject ? { subject } : {}),
          body: caseOverEvents(members, (t) => t.inApp.body),
          ...(redirectUrl
            ? { redirect: { url: redirectUrl, target: "_self" } }
            : {}),
          skip: inAppSkipRule(family.category),
        },
      },
    ],
  };
}

export function allFamilyDtos(): CreateWorkflowDto[] {
  return FAMILIES.map(toFamilyDto);
}
