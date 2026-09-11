---
title: Typed versioned cancellation policy
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-09-05
---

# ADR 28 — Typed versioned cancellation policy

## Context

From the June 2026 refund work until now, the terms that governed a booking's refund were a Json snapshot written onto the appointment at checkout. `Appointment.cancellationPolicySnapshot` held a small object — a version number, a tier ladder, and optionally the organisation's prose policy — and `resolveCancellationPolicySnapshot()` produced it from hardcoded platform defaults. The snapshot solved the problem it was built for: it froze a buyer's terms at the moment of sale, so editing a policy later could not retroactively change what someone had already paid for.

It did not solve anything else, and three things had accumulated against it.

The first is that nothing was ever stored in it but the platform defaults. The function had an `ORG_DEFAULT` arm that no caller reached, because there was nowhere for an organisation to put its own tiers. Organisations have a free-text `defaultCancellationPolicy` field that renders as prose and binds nothing, so "our policy is 48 hours" was a sentence on a settings page while every refund on the platform settled on the same 24/50/2 ladder. The snapshot was a freeze mechanism with nothing varying behind it.

The second is that every reader had to defend itself. Six call sites read the column, each through `parsePolicySnapshot()`, which validated an untyped `Prisma.JsonValue` at runtime and returned null when the shape did not match. A malformed row and an absent row were indistinguishable at the call site, so each reader independently fell back to the defaults. Six copies of one fallback is six chances to disagree about what a booking with no terms means.

The third is that the subscription placeholder never carried a snapshot at all. Checkout wrote one for consultations and the allocator wrote one for each allocated session, but the placeholder appointment that actually carries a subscription's money was created without terms. `resolveBookingRefundContext` compensated with a fallback that reached across to "any session row's snapshot" — a workaround whose only reason to exist was the gap in the writer.

Separately, #1500 needed an answer to a money question the snapshot model had no room for: what a partial refund tier means for a booking funded entirely with referral credit, where the credits rail can restore the whole credit or none of it and nothing in between.

## Decision

Refund terms become typed, versioned, immutable rows, and the Json column is frozen.

1. `CancellationPolicy` is one published version of a policy. It carries its scope — `organizationId` null for the platform default, otherwise the owning organisation — a `version`, a `CancellationPolicyStatus` of `ACTIVE` or `ARCHIVED`, the percentage a consultant-initiated cancellation settles at, and an optional copy of the organisation's prose at publication time for the support trail. `CancellationPolicyTier` holds the rungs: a notice threshold in hours and a refund percentage. Both percentages are stored in basis points, per ADR 02.

2. `Appointment.cancellationPolicyId` is a nullable FK at `onDelete: SetNull`. Null means the platform ladder, which is also what a booking sold before this change reads as, and the two are deliberately indistinguishable. `SetNull` rather than `Cascade` because a booking must survive its organisation being torn down; losing the pointer degrades to the platform ladder rather than deleting money history.

3. **A published version is immutable.** Editing an organisation's ladder archives the current `ACTIVE` row and inserts a new one at the next version number; it never updates a row in place. This is what makes the freeze structural. The old snapshot's guarantee rested on the writer choosing not to backfill; this one rests on there being no code path that can rewrite a row an appointment cites.

4. **An organisation's ladder governs the bookings that organisation funds.** Checkout resolves the version once, inside the booking transaction, passing the organisation id only on the sponsored path. A personal booking tagged to an organisation keeps the platform ladder, because the refund settles to the member and not to the organisation.

5. The platform default lives at a fixed id, is created by the seed, and is created idempotently by `ensurePlatformCancellationPolicy()` on first use, so a database nobody seeded cannot fail a checkout.

6. `Appointment.cancellationPolicySnapshot` stays in the schema, frozen: never written, never read, annotated as such, and dropped at the pre-MVP reset rather than now. A column that a currently-running deploy still reads must not be dropped under it, and the repo does not write backfill migrations.

7. Reading and publishing are one module (`cancellation-policy-store.ts`) with one select shape; the tier maths stays in a Prisma-free module (`cancellation-policy.ts`) that is unit-tested with no mocks. One ladder-validation function is shared by the Zod body schema, the publish helper and the seed, so the editor cannot accept a ladder the quote cannot read.

The #1500 credit rule rides on the same quote. A booking funded entirely by free or referral credit restores that credit **in full** inside any tier above zero per cent, and restores **nothing** inside a zero-per-cent tier.

## Alternatives considered

**Keep the Json column and put organisation tiers inside it.** This is the smallest change and it was rejected on integrity. A Json blob cannot be pointed at, so there is no way to ask which bookings a given set of terms governs, no referential guarantee that the terms cited by a booking still exist in a coherent form, and no place to hang an audit row saying who published them. It also keeps the runtime-validation tax at all six readers, and it does nothing about the missing write on the subscription placeholder.

**Mutable per-organisation policy rows, with a snapshot copied at checkout.** This gives per-organisation tiers with a simpler editor: one row per organisation, edited in place, and the terms copied onto the booking at sale. It was rejected because it reintroduces the copy that the FK exists to remove. Two representations of the same terms drift, and the copy is the one that decides money while the row is the one humans read and edit. Versioning gets the freeze and a single representation at the same time.

**Full temporal-table versioning, with validity ranges on every row.** Rejected as machinery out of proportion to the problem. The question this model has to answer is "which terms governed this sale", and an FK to an immutable row answers it exactly. Nothing here needs "what did this organisation's policy look like on an arbitrary date", and the archived versions plus their `createdAt` and `archivedAt` timestamps would answer even that.

**Enforce one `ACTIVE` version per scope with a partial unique index now.** The index is written and staged in `prisma/sql/check-constraints.sql`, commented out. It needs the `NULLS NOT DISTINCT` form, because Postgres treats null keys as distinct and the platform row would otherwise escape a plain unique entirely. It stays commented because the sidecar checker strips comments and would demand an index that has not been applied, and because it can fail against pre-reset rows. Until it lands, one active version per scope is enforced by the Serializable rotation in `publishOrgCancellationPolicy()`, and readers order by `version desc` and take one so that a slip degrades to "the newest version wins" rather than to an arbitrary answer.

**Allow partial credit restoration for #1500.** Not available: `refundBookingPayment` refuses an `amountPaise` on the credits rail, so a fraction of a credit is not a thing the system can pay. The real choice was between restoring the whole credit and escalating to a human, and escalation is what the code did. Restoring in full inside a partial tier was chosen because the buyer gave the notice the ladder rewards and the rail's inability to divide should not cost them the refund. **Restoring nothing inside the zero tier** was chosen for the mirror-image reason: paying a full credit back for a cancellation that earns a card buyer nothing would make free credit strictly better than money and would delete the late-cancel deterrent for exactly the bookings that cost the least to make.

## Consequences

Organisations can set their own refund terms for the sessions they fund, which is the feature; the prose `defaultCancellationPolicy` field stays as display copy beside it rather than being retired, because it says things a ladder cannot. The `MANUAL_REVIEW` refund status is gone from the cancel route, the client and the docs, and with it the operator queue it fed.

The cost is a second write path at checkout and a new pair of tables to reason about, and the fact that "edit our policy" is really "publish a new version" — which the editor copy says explicitly, because a user who expects an edit and gets a version is entitled to know why their old one is still listed.

Two limitations are known and accepted. Webinar and class seats fall back to the platform ladder, because one shared `Appointment` row serves every registrant across every funding organisation and cannot carry one buyer's terms; reaching event seats would mean moving the terms onto the participant row, and whole-event refunds already assume the platform ladder. And a `free_` intent carrying a non-zero amount is a mixed payment that settles on the money arm and is refused with `INVALID_AMOUNT`; that is pre-existing behaviour, untouched here.

The decision should be revisited if organisations start needing per-plan rather than per-organisation ladders, or if event seats need organisation terms — either would move where the FK lives, not whether the model is typed.

## Related

- ADR 02 (integer paise and basis points) — why the percentages are stored in basis points.
- ADR 13 (Postgres-native concurrency) — the Serializable rotation that keeps one version active, in the absence of the staged index.
- ADR 18 (open B2B/B2C boundary) — the funding-source reading that decides an organisation's ladder governs what the organisation funds.
- `docs/booking/08-cancellation-flow.md` (where the tiers come from; the credit rule), `docs/booking/17-org-funded-checkout.md` (whose policy applies on the org rails).
- #1499 (the model), #1500 (the credit rule), #1503 (the booking closure train).
