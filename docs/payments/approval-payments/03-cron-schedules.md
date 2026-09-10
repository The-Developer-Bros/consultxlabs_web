# Cron Schedules & Cleanup Jobs

> Rewritten in wave 5 (#1319). The `GET /api/cleanup/approval-payments` route this page used to describe was shaped for Vercel Cron, was never scheduled on this deployment, and reverted approved-but-unpaid requests to `PENDING`, which made the consultee re-request a session the consultant had already approved. The route is deleted. There is now one outcome for "approved but never paid", described below.

## What runs

The scheduled cleanup is `scripts/payments/cleanup-abandoned-payments.ts`, wrapped by `jobs/payments/cleanup-abandoned-payments.ts` and run by GitHub Actions every fifteen minutes (`6-59/15 * * * *`). It has two arms.

The first arm handles direct checkouts whose payment lapsed. It moves the request to `EXPIRED` through the CAS helper in `lib/booking/transitions.ts`, soft-cancels the tentative slots (`completionStatus = CANCELLED` with `deletedAt` set), and tombstones the appointment with `deletedAt`. Nothing is hard-deleted, so the `Payment` rows, referral-credit usage and any late capture keep their target. A request that a capture or an approval moved since the cohort read fails the CAS, is counted as skipped, and is left alone.

The second arm, `cleanupExpiredApprovalPendingPayments`, handles requests the consultant approved that the consultee never paid. Once the pay link's window has passed it moves the request from `APPROVED_PENDING_PAYMENT` to `EXPIRED` with the same CAS guard and marks the lapsed payment rows `EXPIRED`. `EXPIRED` is the only terminal state for this cohort; the seven-day `expire-stale-requests` job uses the same state for requests nobody decided.

## Reading the run

Each run prints the number of rows processed, cleaned, skipped and failed, and `success` is true only when nothing failed. A skipped row is not a failure: its status moved between the cohort read and the write, which is the guard working. Run it locally with `npx tsx scripts/payments/cleanup-abandoned-payments.ts`; it takes no arguments and is safe to re-run because every write is conditional on the current status.
