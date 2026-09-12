/**
 * Step conditions for the in-app step, as the JSON Logic Novu's dashboard
 * stores in the `skip` control. Novu inverts the result — the step RUNS when
 * the rule is true (construct-framework-workflow.usecase.ts: "The Step
 * Conditions in the Dashboard control the step execution").
 *
 * Every rule is `!= false`, never `== true`: a subscriber whose flag was
 * never written resolves to null, and `null == true` would silence them.
 * The flags default to true only in the writer, not in Novu.
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

type NotFalse = { "!=": [{ var: string }, false] };
export type SkipRule = { and: NotFalse[] };

function notFalse(flag: string): NotFalse {
  return { "!=": [{ var: `subscriber.data.${flag}` }, false] };
}

export function inAppSkipRule(category: PreferenceCategory | null): SkipRule {
  const rules = [notFalse(ROUTING_BELL_FLAG)];
  if (category) rules.push(notFalse(CATEGORY_FLAG[category]));
  return { and: rules };
}
