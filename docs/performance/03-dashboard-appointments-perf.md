# Consultee dashboard — slow /api/appointments query

## Summary

The consultee dashboard's appointments list (`GET /api/appointments`) takes **~2.3s warm** on the shared dev environment. This is independent of page size and is **not** dev-server compilation — it is a real backend cost from sequential DB round-trips plus a deep multi-join query, amplified by remote-Supabase latency. It will persist in production.

> Note: a separate, larger symptom — the dashboard appearing "stuck on a loading skeleton" for 16–60s — is `next dev` on-demand route compilation (cold 16.5s vs. warm 125ms TTFB / 842ms full render) and **disappears in a production build**. That part is out of scope here; this issue is about the residual query cost.

## Measurements (warm, already-compiled dev server, remote Supabase)

| Endpoint | Time |
|---|---|
| `GET /api/health` (light DB ping) | ~0.46 s |
| `GET /api/announcements` | ~0.12 s |
| `GET /api/appointments?perPage=10` | ~2.3–2.4 s |
| `GET /api/appointments?perPage=1` | ~2.27 s (**same as perPage=10**) |

`perPage=1` costing the same as `perPage=10` proves the cost is fixed per-request (query shape / round-trips), not row count or payload size. The ~0.46s health ping is the baseline remote round-trip; the appointments endpoint is ~5× that.

## Root cause (code)

`app/api/appointments/route.ts` performs three **sequential** awaits, each a remote round-trip:

1. `requireApiAuth()` — session resolution
2. `prisma.membership.findMany(...)`
3. `listAppointmentsScoped(...)`

`lib/api/scope/list-appointments.ts` then runs:

```ts
const [total, items] = await prisma.$transaction([
  prisma.appointment.count({ where }),
  prisma.appointment.findMany({
    include: {
      consultation:  { select: { consultationPlan: { select: { title: true } }, requestedBy: { select: { user: { select: { id, name, email } } } } } },
      subscription:  { select: { subscriptionPlan: { select: { title: true } }, requestedBy: { select: { user: { select: { id, name, email } } } } } },
      webinar:       { select: { webinarPlan: { select: { title: true } } } },
      class:         { select: { classPlan: { select: { title: true } } } },
      // + consultant/consultee -> user, organization
      organization:  { select: { id, name, slug } },
    },
  }),
])
```

The `findMany` fans out **LEFT JOINs across all 6 event types** for every row, and the `count` adds another scan — all gated behind the two earlier sequential round-trips.

## Recommended fixes

- **Parallelize independent reads**: run `requireApiAuth` membership/profile lookups and the list query concurrently with `Promise.all` where they don't depend on each other (membership feeds the `where`, but the session + any static lookups can overlap).
- **Trim nested includes**: only one of `consultation/subscription/webinar/class` is non-null per appointment; consider selecting the title via a lighter projection or a discriminated fetch rather than including all six relation trees on every row.
- **Defer/skip `count`** on first paint (or cache it) — pagination total isn't needed before the first rows render.
- **Verify indexes** on the `where` columns used for scoping (consulteeProfileId/consultantProfileId/organizationId + status + startsAt) so neither `count` nor `findMany` scans.
- Confirm whether the remote-DB round-trip count can be reduced (the 3 sequential awaits are the bulk of wall-clock at ~0.46s each).

## How to reproduce

1. Sign in as a consultee (e.g. seeded `aarav.campbell@hotmail.com`).
2. Open the dashboard / call `GET /api/appointments?perPage=1` and `?perPage=10`.
3. Observe ~2.3s for both, vs. ~0.46s for `GET /api/health`.

## Notes

Found while validating booking flows end-to-end (the booking itself works correctly and persists). Environment: local app → remote Supabase dev DB, branch `fix/testsprite-infra`.
