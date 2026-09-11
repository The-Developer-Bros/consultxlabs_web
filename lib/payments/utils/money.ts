// #780 — Prisma result extensions don't apply to _sum/_avg/_min/_max/groupBy,
// so aggregate money reads still surface bigint. Every aggregation site funnels
// through here; the safe-range assert catches the (never-expected) day a sum
// exceeds 2^53-1 paise instead of silently losing precision.
export function sumPaise(v: bigint | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`money value outside Number safe range: ${v}`);
  }
  return n;
}

// #778 §C — THE rounding/residual policy. Every money split floors each
// share and assigns the leftover paise to ONE named party (the owner within
// a collaborator pool; PLATFORM_FEE across funding/tax splits) so shares
// always sum to the total exactly. Math.round-per-share can overshoot the
// total and turn the residual party's share negative — the #778 §C-2 bug.
export function splitByBps(
  totalPaise: number,
  bpsList: number[],
  residualIndex: number,
): number[] {
  const bpsSum = bpsList.reduce((a, b) => a + b, 0);
  if (bpsSum > 10_000) {
    throw new Error(
      `splitByBps: shares sum to ${bpsSum} bps (> 10000) — refusing a split that exceeds the whole`,
    );
  }
  if (residualIndex < 0 || residualIndex >= bpsList.length) {
    throw new Error(`splitByBps: residualIndex ${residualIndex} out of range`);
  }
  const shares = bpsList.map((bps) => Math.floor((totalPaise * bps) / 10_000));
  const assigned = shares.reduce((a, b) => a + b, 0);
  // When bpsSum === 10000 the residual party absorbs every floored paisa so
  // the split sums to totalPaise exactly; under 10000 the residual is the
  // un-allocated remainder by design and stays with the caller's total.
  if (bpsSum === 10_000) {
    shares[residualIndex] += totalPaise - assigned;
  }
  return shares;
}

/** #778 §C — floored proration (num/den of a total). Callers assign the
 *  remainder explicitly via their residual party; never round. */
export function prorate(
  amountPaise: number,
  numerator: number,
  denominator: number,
): number {
  if (denominator <= 0) {
    throw new Error(`prorate: non-positive denominator ${denominator}`);
  }
  return Math.floor((amountPaise * numerator) / denominator);
}
