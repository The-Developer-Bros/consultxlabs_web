/**
 * Step conditions for the in-app step, as the JSON Logic Novu's dashboard
 * stores in the `skip` control. Novu inverts the result — the step RUNS when
 * the rule is true (construct-framework-workflow.usecase.ts: "The Step
 * Conditions in the Dashboard control the step execution").
 *
 * The comparison value is the STRING "false", not the boolean. Novu replaces
 * json-logic's `!=` with its own (query-parser.service.ts): booleans and the
 * strings "true"/"false" compare as booleans, but a never-written flag is
 * null, and null against boolean false falls through to Number(), where
 * `Number(null) === Number(false) === 0` — so `!= false` SKIPPED every
 * subscriber whose flag was never written (found on the first sync,
 * 2026-09-13). Against "false", null takes the strict fall-through
 * (`null !== "false"`) and runs; true runs; false and "false" skip.
 */

import type { PreferenceCategory } from "./types";

const CATEGORY_FLAG: Record<PreferenceCategory, string> = {
  appointments: "categoryAppointments",
  payments: "categoryPayments",
  subscriptions: "categorySubscriptions",
  trials: "categoryTrials",
  support: "categorySupport",
  feedback: "categoryFeedback",
  orgBilling: "categoryOrgBilling",
  orgMembership: "categoryOrgMembership",
  orgProgram: "categoryOrgProgram",
};

/** Workspace routing (BELL_ONLY / EMAIL_ONLY / NEITHER) gates every bell. */
const ROUTING_BELL_FLAG = "routingBell";

type NotFalse = { "!=": [{ var: string }, "false"] };
export type SkipRule = { and: NotFalse[] };

function notFalse(flag: string): NotFalse {
  return { "!=": [{ var: `subscriber.data.${flag}` }, "false"] };
}

export function inAppSkipRule(category: PreferenceCategory | null): SkipRule {
  const rules = [notFalse(ROUTING_BELL_FLAG)];
  if (category) rules.push(notFalse(CATEGORY_FLAG[category]));
  return { and: rules };
}
