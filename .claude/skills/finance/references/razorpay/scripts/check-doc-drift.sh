#!/usr/bin/env bash
# Guards the razorpay skill bundle against the specific wrong claims it was
# corrected for. Each pattern below was live in these docs at some point and had
# to be fact-checked out; this stops them creeping back in silently.
#
#   bash .claude/skills/finance/references/razorpay/scripts/check-doc-drift.sh
#
# Exits non-zero on the first violation found. Run it after editing anything in
# .claude/skills/finance/references/razorpay/ or .claude/agents/razorpay-*.md.

set -uo pipefail

# Resolve the repo root from the script's own location so the bundle can move
# without silently scanning nothing (#1483).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../../.." && pwd)"
TARGETS=("$ROOT/.claude/skills/finance/references/razorpay" "$ROOT/.claude/agents")
FAILED=0

for target in "${TARGETS[@]}"; do
  if [ ! -d "$target" ]; then
    echo "FAIL: target directory does not exist: $target"
    echo "      the bundle moved; update TARGETS in $(basename "${BASH_SOURCE[0]}")"
    exit 1
  fi
done

# pattern <regex> <why>
#
# A line may carry a `drift-ok` marker to opt out — for prose that quotes the
# wrong claim in order to correct it. Use it sparingly; it is an escape hatch,
# not a silencer.
check() {
  local pattern="$1" why="$2" hits
  hits=$(grep -rInE "$pattern" "${TARGETS[@]}" \
    --include='*.md' --include='*.sh' \
    --exclude="$(basename "${BASH_SOURCE[0]}")" \
    | grep -v 'drift-ok' || true)
  if [ -n "$hits" ]; then
    echo "FAIL: $why"
    echo "$hits" | sed 's/^/      /'
    echo
    FAILED=1
  fi
}

check 'payment\.refund\.(created|processed|failed|speed_changed)' \
  "refund events are top-level refund.*, not payment.refund.* — a handler on those names sees zero refund webhooks"

check '\bspeed[^a-z]{0,4}(:|=)\s*.optimized' \
  "refund speed values are normal|optimum; 'optimized' does not exist"

check '4111[ -]?1111[ -]?1111[ -]?1111' \
  "Razorpay's documented test cards are the 4100 2800 family; 4111... is generic tutorial filler"

check "(pause|resume)_initiated_by.*(request|param|-d )" \
  "pause/resume take pause_at / resume_at; *_initiated_by is response-only"

check 'can REPLAY|replay the individual event|Dashboard can [Rr]eplay' \
  "there is no self-serve webhook replay — it is a support ticket, <=15 days, one event at a time"

check 'sacCode.{0,20}99831[45]|SAC [Cc]ode:? .?99831[45]|SAC 99831[45]' \
  "SAC codes come from lib/payments/payouts/constants.ts (999293 family), not the IT-services codes"

check 'notify_info.*(fictional|does not exist|not a real|isn.t real)' \
  "notify_info IS real (notify_phone/notify_email on Create Subscription Link)"

check 'RAZORPAY_KEY_SECRET' \
  "this repo's env var is RAZORPAY_SECRET"

# current_period_end is legitimate as an app-side COLUMN name, so only flag it
# where it is presented as something Razorpay sends.
check '(payload|entity|response|Razorpay)[^.]{0,20}\.current_period_end' \
  "Razorpay sends current_end; current_period_end is a Stripe-ism"

if [ "$FAILED" -eq 0 ]; then
  echo "OK: no known-stale Razorpay claims found."
fi
exit "$FAILED"
