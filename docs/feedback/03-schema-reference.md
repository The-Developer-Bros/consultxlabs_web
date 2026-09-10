# Schema reference: `AppointmentFeedback`

One row per person per call. The table is additive-only and every column added since the original model is nullable, so nothing here needs a backfill. The table below lists every column and index and why it exists; the behaviour behind each is in [01-architecture.md](01-architecture.md).

| Column or index                                     | Why it exists                                                                                                                                                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slotOfAppointmentId?` (`Cascade`)                  | The call being rated, always the run anchor. Nullable only for rows written before feedback moved to the per-call unit; the API requires it.                                                                          |
| `appointmentId` (`Cascade`)                         | Kept beside the slot: the org quality aggregate and every appointment-scoped read filter on it, and denormalising it avoids a join on the hottest path.                                                               |
| `userId` (`Cascade`), `organizationId?` (`SetNull`) | The rater, and the sponsoring organisation copied from the appointment at write time so the aggregate needs no join.                                                                                                  |
| `rating` (`SmallInt`), `comment?` (`Text`)          | The score, disclosed to the rated party; the note, disclosed to the rater only.                                                                                                                                       |
| `raterRole?` (`AppointmentFeedbackRole`)            | `CONSULTEE` or `PROVIDER`. Nullable and never backfilled, so aggregates filter _on_ `CONSULTEE` and unknown provenance fails closed.                                                                                  |
| `createdAt`                                         | The clock the organisation's thirty-day window uses.                                                                                                                                                                  |
| `updatedAt?`                                        | `NULL` = never edited since it was written. Set by the route only when the rating or the comment changed, and deliberately not `@updatedAt`, which Prisma stamps on create as well and would make `NULL` unreachable. |
| `deletedAt?`                                        | `NULL` = live. Moderation soft-delete; the aggregate and the author's read filter on it, staff surfaces do not. No writer exists yet.                                                                                 |
| `ratingCause?` (`RatingCause`)                      | What the rater says drove a low score. A claim, shared with `ConsultantReview`; see [rating cause and aggregate exclusion](../reviews/04-rating-cause-and-aggregate-exclusion.md).                                    |
| `excludedFromAggregateAt?`                          | The staff adjudication that removes the row from every aggregate while leaving it stored. No writer exists yet.                                                                                                       |
| `@@unique([slotOfAppointmentId, userId])`           | One rating per person per call. Rows predating the column carry a `NULL` slot, and Postgres treats a `NULL` key as distinct, so they coexist rather than colliding on the appointment they share.                     |
| `@@index([appointmentId, userId])`                  | Still the unit for "show me this booking's feedback".                                                                                                                                                                 |
| `@@index([organizationId, raterRole, createdAt])`   | Replaced `[organizationId, createdAt]`. The org aggregate filters `raterRole` before the date range, which left the old two-column index without a usable prefix.                                                     |

## Related

- [02-org-quality-signal.md](02-org-quality-signal.md) — the read that the last index serves.
- [`docs/support/05-schema-reference.md`](../support/05-schema-reference.md) and [`docs/reviews/06-schema-reference.md`](../reviews/06-schema-reference.md) — the sibling tables.
