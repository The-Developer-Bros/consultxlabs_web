/**
 * Known-drift baseline for the ledger reconciler.
 *
 * The reconciler exits 2 on any finding, which pages ops. On 2026-07-28 it had
 * been red for twelve consecutive runs on 59 findings, every one of them a seed
 * artifact: the seed scripts write terminal money states (a COMPLETED payout, a
 * reversed earning) without posting the matching journal transaction, which is
 * exactly what the detector is built to catch. Global ledger balance was — and
 * is — zero paise, so the double-entry invariant itself was never in question.
 *
 * A detector that is permanently red is not a detector. The reconciler's own
 * documentation makes this point about a different check: "letting a known,
 * tracked coverage gap fail the nightly run would train ops to ignore a red
 * reconciler — the worst possible outcome for a safety net."
 *
 * So known findings are baselined by identity: they still print in full, they
 * still land in the persisted report, but they do not flip `ok` to false. A NEW
 * finding — the thing we actually want to hear about — turns the run red again.
 *
 * Two properties keep this from becoming a way to silence real problems:
 *
 *   - Entries are keyed to a SPECIFIC entity id, never to a finding kind. A new
 *     COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN on a different payout is not covered.
 *   - Every entry carries an expiry. Past it the finding counts again, so the
 *     baseline cannot quietly outlive the cleanup it was waiting on. The
 *     pre-MVP database reset removes the seed rows and this file empties out.
 */

export type BaselineEntry = {
  kind: string;
  /** The entity id this finding is about — payoutId, paymentId, accountId, etc. */
  entityId: string;
  reason: string;
  /** ISO date. After this the finding is no longer excused. */
  expires: string;
};

/**
 * Seed-origin findings recorded from report 22c63944-7135-4ec4-b925-a8e1aa585dfa
 * (2026-07-28). Populated by `npm run ledger:baseline` rather than by hand, so
 * the ids are whatever the reconciler actually reported.
 */
export const LEDGER_BASELINE: BaselineEntry[] = [
  {
    kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
    entityId: "cmqb27ds306dttxyoeviohduq",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
    entityId: "cmqb27e1l06dvtxyomxasw6w3",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
    entityId: "cmqb27e6a06dwtxyot6hk2ezd",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
    entityId: "cmqb27eax06dxtxyo3a0uohsj",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
    entityId: "cmqb27efc06dytxyomny7mx9x",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
    entityId: "cmqb27eob06e0txyorl7zb6pz",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
    entityId: "cmqb27f1p06e3txyolfd739mk",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
    entityId: "cmqb27faj06e5txyoa6oi4kcg",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
    entityId: "cmqb27fji06e7txyok165f3s8",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
    entityId: "cmqb27fsk06e9txyohz1usrx4",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
    entityId: "cmqb27g1j06ebtxyo78ymvucv",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
    entityId: "cmqb27g5w06ectxyo1u8s2fdm",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "EARNINGS_LEDGER_DRIFT",
    entityId: "deadbeef-0000-4000-8000-000000007001",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "EARNINGS_LEDGER_DRIFT",
    entityId: "deadbeef-0000-4000-8000-000000007003",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "065cb340-6718-466b-904d-dbc735bfa725",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "16c1d169-2f57-479e-b12e-b0a42a11ea70",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "19ef653e-a647-4ddf-9a9d-4a56fd1538fb",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "2272bb7f-e94d-4e7f-bc80-2fa80aa5b7f2",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "237271d7-8819-470c-a4e5-6f98b9f9bb53",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "2701b839-e789-45dc-889b-359abfa045a6",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "34e196a3-b16a-4597-8f6d-cbe250416c9d",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "37aa4632-0865-4e01-a319-fcacc5c436f0",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "3c8ba75b-0c53-478e-b62f-bf8058fa2b06",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "3ce2d862-7e53-4c6b-8919-6e1a83b43a33",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "3d74cbb0-02fc-4022-b223-29e52643a6fb",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "3f3641a4-ac68-40e8-beb4-abff0c1e3088",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "419bc8af-e42c-436a-b400-15eaaeefddcd",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "41d02949-4673-4c1a-ba4f-b6b439fcee3f",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "420d9c66-5fad-480f-b3db-ec9a8962382e",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "4747c89b-e4d0-4240-afee-3bbe463cacd1",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "4d65ebe7-878b-4ff3-8660-3b70cdd85001",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "4f6a535c-d833-48aa-9a3c-f958a52b4944",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "50626999-6141-47a7-829e-c660d20ad60b",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "554d0e73-da97-4fef-8324-036c4ac55e23",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "57ebb457-31d8-4d60-a3ba-6cb20842822d",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "5ef18232-458e-4239-adc5-1e2130799702",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "612cd101-7ee1-4932-8613-b1430acdc700",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "6368ae1b-0e3d-4d81-8984-8ecb79b117d5",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "645c70f2-69f6-46dc-8b86-0afbdce477bc",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "6af34b69-73aa-4053-91cb-d5d16c0ab328",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "6b0dfb6e-c6d8-4ac0-bfc6-bbf29d2d3a18",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "76b93939-076c-47bc-8319-98ab4b219e5b",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "7906dbe3-7498-4a9f-a5ae-fa9503dd4be8",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "7ef5e6cb-5a1a-4e2a-9291-c74ba58877f6",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "82925ac4-b222-4e62-a3e3-e2961debf551",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "87a21a70-d7f5-4c65-b12a-50fed9a4cbc2",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "8c74cb32-ba89-48d6-a862-f94446279f33",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "8de27fd6-0216-4733-895c-39b40176e7e6",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "989fabc6-6432-4910-a846-b6213224ead9",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "993266db-8261-464a-84c1-fef80e86c33c",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "995bb4eb-7124-4c66-bfea-7d3d3a7b1ca0",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "9ab69258-db34-40b8-abb8-ee319451bf9d",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "9ecdd3b7-89c6-4c95-b1cd-b7be56571663",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "a24b0fd2-98b0-4761-be93-9cb139a0e457",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "a9dbb310-e5b2-430b-903f-912b6797616d",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "ac6c2761-b349-423e-8f15-797d775fa1b6",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "b3f9bcd5-a18b-4e9e-97f2-6135156c4aec",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "ba659e5c-4233-4361-8343-01720ce4b273",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
  {
    kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
    entityId: "bcf69af1-a5f6-4a50-a3ec-9f29d461cb9d",
    reason: "seed artifact (report 22c63944) — clears at the pre-MVP reset",
    expires: "2026-10-31",
  },
];

/** Stable identity for a finding: its kind plus the entity it points at. */
export function findingIdentity(finding: {
  kind: string;
  organizationId?: string;
  billingAccountId?: string;
  billingSubscriptionId?: string;
  invoiceId?: string;
  paymentId?: string;
  payoutId?: string;
  programAssignmentId?: string;
  details?: Record<string, unknown>;
}): string {
  const entityId =
    finding.payoutId ??
    finding.paymentId ??
    finding.invoiceId ??
    finding.programAssignmentId ??
    finding.billingSubscriptionId ??
    finding.billingAccountId ??
    finding.organizationId ??
    (typeof finding.details?.accountId === "string"
      ? finding.details.accountId
      : undefined) ??
    "";
  return `${finding.kind}:${entityId}`;
}

export type BaselineSplit<T> = {
  /** Findings that make the run red. */
  active: T[];
  /** Findings excused by an unexpired baseline entry — printed, not fatal. */
  baselined: T[];
  /** Baseline entries whose expiry has passed; their findings are active again. */
  expired: BaselineEntry[];
};

/**
 * Split findings into the ones that should fail the run and the ones a live
 * baseline entry excuses.
 *
 * `now` is injected so this is deterministic under test.
 */
export function applyLedgerBaseline<
  T extends { kind: string; details?: Record<string, unknown> },
>(findings: T[], now: Date, baseline: BaselineEntry[] = LEDGER_BASELINE) {
  const today = now.toISOString().slice(0, 10);
  const live = new Map<string, BaselineEntry>();
  const expired: BaselineEntry[] = [];

  for (const entry of baseline) {
    if (entry.expires >= today) {
      live.set(`${entry.kind}:${entry.entityId}`, entry);
    } else {
      expired.push(entry);
    }
  }

  const active: T[] = [];
  const baselined: T[] = [];
  for (const f of findings) {
    if (live.has(findingIdentity(f))) baselined.push(f);
    else active.push(f);
  }

  return { active, baselined, expired } satisfies BaselineSplit<T>;
}
