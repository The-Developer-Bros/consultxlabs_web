#!/usr/bin/env bash
# #709 — money-cron failure alert.
#
# Originally this no-op'd with a warning whenever SLACK_OPS_WEBHOOK_URL was
# unset. That secret has never been provisioned, so for every cron failure to
# date the alert was a `::warning::` line buried in a log nobody reads — which
# is how reconcile-ledgers stayed red for twelve consecutive runs unnoticed.
#
# Two changes fix that without breaking forks and preview builds:
#   1. Sentry is a fallback sink. SENTRY_DSN is already provisioned, so a
#      failure now reaches an alerting surface even with Slack unconfigured.
#   2. For jobs that move or reconcile money, having NO sink at all is itself a
#      failure: the step exits non-zero so the run is visibly red rather than
#      quietly green-with-a-warning. Non-money jobs keep the old lenient
#      behaviour so forks and preview environments aren't punished.
set -euo pipefail

JOB_NAME="${1:-unknown job}"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"

# Jobs whose failure means money is unreconciled, unpaid, or unrefunded. Keep in
# sync with docs/enterprise/50-operations/07-required-secrets.md.
MONEY_CRITICAL_JOBS="
process-payouts
create-payout-batch
reconcile-payout-status
handle-stuck-payouts
reconcile-ledgers
reconcile-payment-status
reconcile-orphaned-confirmations
reconcile-pending-refunds
cascade-refund-earnings
reconcile-disputes
handle-lost-disputes
release-earnings
sync-payment-earnings
release-pending-trust-earnings
generate-subscription-invoices
settle-invoice-accruals
dunning
sweep-orphaned-topup-captures
cleanup-abandoned-payments
timeout-member-overages
sweep-abandoned-overage-charges
irp-uploader
msme-payment-alerts
"

is_money_critical() {
  echo "$MONEY_CRITICAL_JOBS" | grep -qx "$1"
}

delivered=0

# --- Sink 1: Slack (primary) -------------------------------------------------
if [ -n "${SLACK_OPS_WEBHOOK_URL:-}" ]; then
  # jq-built payload: printf interpolation produced malformed JSON for job
  # names containing quotes or backslashes.
  payload=$(jq -n --arg job "$JOB_NAME" --arg url "$RUN_URL" \
    '{text: (":rotating_light: *" + $job + "* failed.\n<" + $url + "|Run logs>")}')
  if curl -fsS -X POST -H 'Content-Type: application/json' -d "$payload" "$SLACK_OPS_WEBHOOK_URL"; then
    delivered=1
  else
    echo "::warning::Slack notification failed for ${JOB_NAME}"
  fi
fi

# --- Sink 2: Sentry (fallback) ----------------------------------------------
# Parse the DSN (https://<key>@<host>/<project_id>) and post a minimal event to
# the store endpoint. Deliberately dependency-free: the runner has curl and jq
# but this step must not require `npm ci` to have succeeded.
if [ -n "${SENTRY_DSN:-}" ]; then
  dsn_key="$(echo "$SENTRY_DSN" | sed -E 's#^https?://([^@]+)@.*#\1#')"
  dsn_host="$(echo "$SENTRY_DSN" | sed -E 's#^https?://[^@]+@([^/]+)/.*#\1#')"
  dsn_project="$(echo "$SENTRY_DSN" | sed -E 's#.*/([0-9]+)$#\1#')"

  if [ -n "$dsn_key" ] && [ -n "$dsn_host" ] && [ -n "$dsn_project" ]; then
    level="error"
    if is_money_critical "$JOB_NAME"; then level="fatal"; fi
    event=$(jq -n \
      --arg job "$JOB_NAME" --arg url "$RUN_URL" --arg level "$level" \
      '{
         message: ("cron failed: " + $job),
         level: $level,
         platform: "other",
         logger: "github-actions",
         tags: { subsystem: "cron", job: $job },
         extra: { run_url: $url }
       }')
    if curl -fsS -X POST \
        -H 'Content-Type: application/json' \
        -H "X-Sentry-Auth: Sentry sentry_version=7, sentry_client=notify-ops-failure/1.0, sentry_key=${dsn_key}" \
        -d "$event" \
        "https://${dsn_host}/api/${dsn_project}/store/" >/dev/null; then
      delivered=1
    else
      echo "::warning::Sentry notification failed for ${JOB_NAME}"
    fi
  else
    echo "::warning::SENTRY_DSN is set but could not be parsed for ${JOB_NAME}"
  fi
fi

# --- No sink reached ---------------------------------------------------------
if [ "$delivered" -eq 1 ]; then
  exit 0
fi

if is_money_critical "$JOB_NAME"; then
  echo "::error::${JOB_NAME} failed and NO alert sink is configured (SLACK_OPS_WEBHOOK_URL and SENTRY_DSN both unset or unreachable). A money job failing silently is itself an incident — see docs/enterprise/50-operations/07-required-secrets.md"
  exit 1
fi

echo "::warning::No alert sink configured — failure for ${JOB_NAME} was not paged"
exit 0
