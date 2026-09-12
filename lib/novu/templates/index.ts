import type { CreateWorkflowDto } from "@novu/api/models/components";
import { B2C_TEMPLATES } from "./b2c";
import { ORG_TEMPLATES } from "./org";
import { inAppSkipRule } from "./conditions";
import {
  EVENT_FAMILY,
  FAMILIES,
  familyOf,
  type Family,
  type FamilyId,
} from "./families";
import type { NovuWorkflowId, WorkflowTemplate } from "./types";

export type {
  InAppTemplate,
  PreferenceCategory,
  WorkflowTemplate,
} from "./types";
export { EVENT_FAMILY, FAMILIES, familyOf } from "./families";
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

/** The one payload field every family's redirect reads. */
export const HREF_FIELD = "href";

/**
 * What actually goes over the wire: the family as the workflow, the event
 * as a payload field the template branches on, and the event's destination
 * copied into `href` because a redirect cannot branch (types.ts). Every
 * trigger helper calls this and nothing else knows the families exist.
 */
export function toWire<T extends Record<string, unknown>>(
  event: NovuWorkflowId,
  payload: T,
): { workflowId: FamilyId; payload: T & { event: string; href?: string } } {
  const family = EVENT_FAMILY[event];
  if (!family) {
    throw new Error(`Novu: "${event}" has no workflow family`);
  }
  const field = templateFor(event)?.inApp.redirect;
  const destination = field ? payload[field] : undefined;
  return {
    workflowId: family,
    payload: {
      ...payload,
      event,
      ...(typeof destination === "string" && destination
        ? { [HREF_FIELD]: destination }
        : {}),
    },
  };
}

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
    .map(([event, text]) => `{% when '${event}' %}${text}`)
    .join("");
  return branches ? `{% case payload.event %}${branches}{% endcase %}` : "";
}

/**
 * The exact document the sync writes for a family. Tags carry the category
 * so the Inbox can filter on it. Payload validation is off and no
 * `payloadSchema` is sent: the app's types are the schema, and a strict one
 * rejected a valid trigger once (#1442).
 */
export function toFamilyDto(family: Family): CreateWorkflowDto {
  const members = templatesInFamily(family.id);
  if (members.length === 0) {
    throw new Error(`Novu family "${family.id}" has no events`);
  }
  const subject = caseOverEvents(members, (t) => t.inApp.subject);
  // One variable, not a `case`: Novu's IN_APP_REDIRECT_URL_REGEX admits a
  // url that starts with `{{…}}`, `http(s)://` or `/` and nothing else. An
  // event with no destination leaves `href` unset, which renders empty and
  // Novu then drops the redirect rather than storing a blank one.
  const redirectUrl = members.some((t) => t.inApp.redirect)
    ? `{{payload.${HREF_FIELD}}}`
    : "";
  return {
    workflowId: family.id,
    name: family.name,
    // Novu caps a description at 256 characters; org-billing's ten events
    // overflowed it on the first sync. The events are listed in families.ts.
    description: `${family.description} ${members.length} events; see lib/novu/templates/families.ts.`,
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
