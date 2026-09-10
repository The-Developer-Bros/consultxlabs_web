# Recordings Marketplace (#366) — Curated Replay Library

Status: implemented on `fix/content-delivery`. This doc is the source of truth
for the sellable-recordings design decisions and their invariants.

## What it is

An opt-in, consultant-curated marketplace for **webinar/class replays only**:

- Consultant publishes individual `Recording` rows (`listingStatus=PUBLISHED`)
  with price, copy, tags, slug, preview clip.
- Buyers purchase standalone replays from `/explore/recordings` — no booking
  required. Playback lands in their dashboard resources.

## Non-negotiable invariants

1. **SUPABASE-only listings.** A published recording must have
   `status=AVAILABLE && storageType=SUPABASE`. Stream S3 URLs die in ≤14 days
   and are non-revocable — a STREAM_ONLY replay must never be sold. Enforced
   by `publicRecordingWhere()` (`lib/data/recordings-explore.ts`) AND again in
   the publish route (defense in depth; the where-clause alone would let an
   already-listed recording lapse silently).
2. **Webinar/class plans only.** Consultation/subscription recordings cannot
   be listed. 1:1 sessions stay private by design; the plan schemas never
   exposed `recordingEnabled`, so the DB defaults hold everywhere.
3. **Consent attestation at publish.** `consentAttestedAt/ById` is written in
   the same update as PUBLISHED — no attestation, no listing. Registration-time
   "replay may be sold" checkbox is the planned follow-up (needs a schema
   field; see Open items).
4. **Metadata-only public reads.** `/api/explore/recordings` (public prefix,
   middleware) returns listing metadata only. Playback URLs come exclusively
   from the authenticated `/api/stream/recordings/[recordingId]` route after
   entitlement: owner / collaborator / privileged / plan-payment (refund-aware)
   / SUCCEEDED `RecordingPurchase`.
5. **Manual transfer = premium.** The transfer route resolves the owning
   plan's `recordingStoragePolicy`; STREAM_ONLY gets `403 UPGRADE_REQUIRED`
   instead of free permanent storage.

## Purchase flow

```
POST /api/recordings/[id]/purchase        → Razorpay order, notes.type=recording_purchase
                                          → RecordingPurchase row (PENDING, gatewayOrderId unique)
payment.captured / order.paid webhook     → handleRecordingPurchaseSuccess (PENDING→SUCCEEDED)
payment.failed                            → handleRecordingPurchaseFailure (only from PENDING)
```

Deliberately NOT a `Payment` row: bookings own the ledger/appointment
invariants; this is a two-party digital good settled off `gatewayOrderId`.
Refunds are manual/support-led in v1 (mark row REFUNDED); automated refund
plumbing through the existing refund family is future work.

## Storage layout

| Asset | Bucket | Visibility |
|---|---|---|
| Full recording | `recordings` | private, signed 1h |
| Preview clip + thumbnail | `recordings-previews` | **public**, immutable cache |

Preview assets are marketing material for ISR-cached anonymous explore cards;
signed URLs would expire under cache. Deterministic paths
(`<recordingId>/…`) keep re-uploads orphan-free.

## Caching

`/explore/recordings` uses ISR (`revalidate=300`). Publish and unpublish call
`revalidatePath("/explore/recordings")` (+ the affected detail path) at the
write site, so listing cards never outlive an unpublish by more than one
request. The public list API additionally sends a short CDN
`Cache-Control` (`s-maxage=60, stale-while-revalidate=300`).

## Open items

- Preview-clip accessibility (#1244 R2): WebVTT caption track or transcript
  alongside `previewClipUrl` for clips containing speech. Deferred — needs a
  transcript asset pipeline; detail page currently renders clip without track.
- Registration-time redistribution-consent checkbox (schema field on the
  attendee join), feeding the publish attestation instead of relying on it.
- Automated refunds for `RecordingPurchase` via the refund family.
- Consultant-side publish UI (APIs are complete).

## Deploy notes

### Merge-order rule: schema BEFORE build, not after merge

The usual house rule is "merge the PR, then `npm run db:push` from `dev`".
**That rule is wrong for this PR**, and following it deadlocks CI.

`/explore/recordings` is ISR-prerendered during `next build`, so the build
reads the shared database (#932). Its columns arrive with this PR. Push after
merging and the build fails before the merge can happen:

```
The column `Recording.listingStatus` does not exist in the current database.
Export encountered an error on /explore/recordings/page — exiting the build.
```

The order for any PR that adds columns AND prerenders a page that reads them:

1. Bring the branch fully up to date with `dev` (`git merge origin/dev`), so
   its schema is a strict superset — a push from a branch reconciles the DB to
   THAT branch's schema, and anything missing from it is dropped.
2. Verify the delta is additive: `npx prisma migrate diff
   --from-config-datasource --to-schema prisma/schema.prisma --script` and
   confirm there is no `DROP TABLE`, `DROP COLUMN` or `SET NOT NULL`.
3. `npx prisma db push` from the branch, then `npm run db:sidecars`.
4. Re-run CI and the deploy preview, then merge.

On step 3, `db push` warns that adding the `Recording.slug` unique constraint
"will fail if there are existing duplicate values". For a NEW nullable column
that warning is a false positive — every existing row gets NULL, and Postgres
unique indexes permit unlimited NULLs. Confirm the column does not yet exist,
then `--accept-data-loss` is safe. Confirm first; do not reach for the flag by
reflex.


⚠️ **Schema drift hazard (hit twice on #1244):** until this branch squashes
into `dev`, a `prisma db push` run from any checkout whose schema.prisma
lacks these columns (i.e., plain `dev`) will silently DROP them — the
marketplace listing then fails prerender with P2022
(`Recording.listingStatus does not exist`). If a preview fails with that
error, re-apply the additive SQL (see PR #1244 description / this file's
history) rather than debugging the app.

`/explore/recordings` is ISR-prerendered at build time and the page data
fetch fails loudly on error (withBuildTimeRetry). A deploy-preview built before this
PR's schema columns exist on the shared database will therefore fail during
prerender (`column Recording.listingStatus does not exist`). If a preview of
this branch fails with a Prisma column error, apply the additive schema
first (see migration notes in this repo's db:push flow), then retrigger.
