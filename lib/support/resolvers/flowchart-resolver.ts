/**
 * #appt-support — SELF_SERVE resolver: walks a deterministic FlowDefinition.
 *
 * Thin wrapper over the shared pure walk (`flow-walk.ts`) so the persisted
 * per-appointment threads and the stateless platform intake execute the exact
 * same transition logic. Pure + synchronous over the flow graph (no I/O), so
 * it's cheap, testable, and safe on a money-adjacent surface — it never
 * performs an action itself, only REQUESTS one (SupportAction) for the caller
 * to validate and execute. AI/human resolvers implement the same interface and
 * drop in without touching callers.
 */

import type {
  SupportResolver,
  SupportContext,
  SupportTurnInput,
  SupportTurnResult,
  FlowDefinition,
} from "../types";
import { walkFlow } from "../flow-walk";

export class FlowchartResolver implements SupportResolver {
  readonly channel = "SELF_SERVE" as const;

  constructor(private readonly flow: FlowDefinition) {}

  async resolveTurn(
    ctx: SupportContext,
    currentNodeId: string | null,
    input: SupportTurnInput,
  ): Promise<SupportTurnResult> {
    return walkFlow(this.flow, currentNodeId, input, ctx);
  }
}
