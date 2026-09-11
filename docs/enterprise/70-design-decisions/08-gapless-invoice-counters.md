---
title: Gapless per-org per-fiscal-year invoice counters
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-06-05
---

# ADR 08 — Atomic per-org, per-fiscal-year counters for invoice and credit-note numbers

## Context

The platform issues GST tax invoices and credit notes to host
organizations. India's CGST rules govern how those documents are numbered.
CGST Rule 46(b) requires every tax invoice to bear "a consecutive serial
number not exceeding sixteen characters … unique for a financial year,"
drawn only from alphanumerics plus hyphen and slash; Rule 53 imposes the
same discipline on credit notes but in a *separate* series, and requires
each note to reference the original invoice it adjusts (research bundle A,
F1/F3). The numbering scheme therefore has to be consecutive, unique
within an Apr–March Indian fiscal year, and produced correctly even when
two month-end roll-up jobs mint invoices for the same org at the same
instant. The fiscal year itself has to be reckoned in IST, because an
invoice issued just after midnight IST on 1 April is still 31 March in
UTC, and computing the FY in UTC would file it under the wrong year's
series.

## Decision

Invoice and credit-note numbers come from per-org, per-fiscal-year atomic
counters. `allocateOrgInvoiceSeq` in
`lib/payments/billing/invoice-numbering.ts` does a Prisma `upsert` on
`OrgInvoiceCounter` keyed by `(organizationId, fiscalYear)`: the `create`
path seeds `nextSeq = 2` and allocates seq 1, the `update` path increments
`nextSeq` atomically, and the function returns the pre-increment value.
Because the increment is a single DB-level operation and the compound
`@@id` serialises concurrent allocations, two simultaneous invoice
creations can never mint the same number or skip one.
`generateOrgInvoiceNumber` formats it as `<PREFIX>-<FY>-<SEQ>` with a
4-digit zero-padded sequence, where `PREFIX` is the uppercased
`invoiceNumberPrefix` or the org slug. Credit notes use an independent
counter (`OrgCreditNoteCounter`, `allocateOrgCreditNoteSeq` in
`credit-note-numbering.ts`) in the form `<PREFIX>-CN-<FY>-<SEQ>`,
satisfying Rule 53's separate-series requirement, and reuse the shared
`indianFiscalYear` helper, which shifts the timestamp into IST (`+5.5h`)
before extracting the year so the March/April boundary lands correctly
(#776). A `@@unique([organizationId, invoiceNumber])` constraint is the
belt behind the counter's suspenders, enforcing uniqueness even if the
counter were ever bypassed.

One nuance must be stated honestly: **the law requires consecutive and
unique per financial year, not strictly gapless.** Rule 46(b) does not use
the word "gapless"; a gap explained by a retained cancelled/void document
is permissible, provided the cancelled number is not reused (research
bundle A, F6). Our counter happens to be gapless under normal operation,
which is the *safest superset* of the statutory requirement — gapless
trivially satisfies "consecutive + unique" — and so a rare burned sequence
number from a rolled-back transaction is a documentable exception, not a
compliance defect. We chose the gapless superset deliberately; the code
comments and older docs that call gaplessness "what CGST requires"
overstate the statute slightly, and should read "consecutive + unique per
FY (Rule 46(b)); we implement gapless as the safe superset."

## Alternatives considered

We considered a global monotonic counter shared across all orgs. It lost
on Rule 46(b)'s "in one or multiple series, unique for a financial year":
a per-org series is cleaner for the recipient and resets naturally each
FY, and a global counter would leak one org's invoice volume to another
through the number and complicate the per-FY reset.

We considered `MAX(seq) + 1` computed at insert time inside the
transaction. It lost on concurrency: under anything short of fully
serialized writes, two concurrent month-end roll-ups both read the same
max and both allocate the same next number, producing a duplicate that the
`@@unique` constraint then rejects — turning a correctness bug into a
retry storm at exactly the busiest moment. The dedicated counter's
single-statement `increment` is race-free without forcing serializable
isolation on the whole invoice transaction.

We considered allocating the number lazily at PDF-render time rather than
at row creation. It lost because the number is load-bearing upstream of
the PDF: it is the document number the IRP hashes into the 64-character
IRN (research bundle A, F5), so it must be assigned, stable, and unique at
the moment the invoice row is committed, not deferred.

## Consequences

The real cost we pay is a latent **16-character overflow risk that is not
enforced in code** (🟡, no issue filed yet). `<PREFIX>-<FY>-<SEQ>` is
`len(prefix) + 10` characters with a 4-digit FY and 4-digit seq, so the
invoice prefix must be ≤6 characters to stay within Rule 46(b)'s sixteen;
the credit-note form `<PREFIX>-CN-<FY>-<SEQ>` is `len(prefix) + 13`, so
its prefix must be ≤3 characters — meaning a realistic prefix like `WIPRO`
already produces `WIPRO-CN-2026-0001` at 18 characters, a likely-live Rule
53 breach. Neither numbering function validates or truncates the prefix
length, and a 5th sequence digit (≥10,000 docs in one org-FY) overflows
for any prefix. This belongs on the engineering follow-up list:
validate/truncate the prefix at counter time, document the budget, or
shorten the `-CN` tag.

A second cost is that a rolled-back transaction can durably burn a
sequence number under some isolation paths, leaving a gap. That is legally
fine per F6 as long as the void is auditable, but it means "gapless" is a
property of the happy path, not a guarantee — code and operators must not
treat an occasional missing number as an incident.

Revisit this decision if the platform issues from multiple legal entities
(each needs its own series), or if invoice volume per org-FY approaches
the 4-digit sequence ceiling, or — most urgently — when the 16-character
guard is implemented, which will force a decision on prefix budget and the
`-CN` tag length.
