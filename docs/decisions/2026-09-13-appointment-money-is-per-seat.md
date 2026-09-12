# ADR: on a group event, money is a status per seat, and an attendee sees only their own

- **Status**: Accepted
- **Date**: 2026-09-13
- **Part of**: the appointment detail hub (#1022, #1428). Builds on ADR 20 (org-party reads carry no session content).

## Context

`Payment` is unique per `(userId, appointmentId)`, so a webinar with ten
attendees has ten Payment rows on one appointment. The detail read
(`lib/data/appointment-detail.ts`) returned all of them to any participant,
and the shared detail client rendered them as an anonymous list of amounts
under "Payment & sponsorship". Two things were wrong with that at once.

The host read it as the same payment repeated, because the rows carried no
payer and nothing said they were seats. The roster page, which is where a
host would go to ask "did this person pay", answered a hard-coded
"Registered" for everyone.

Every attendee received every other attendee's amounts, statuses and hold
deadlines — financial data of other people, returned by
`GET /api/appointments/[id]` and hydrated into the consultee page on first
paint. Nothing on screen showed it to a consultee, which is why it went
unnoticed; the API contract did.

Event platforms answer the host's question the same way: Luma's guest list
puts ticket type, amount paid and payment status on the guest row and adds a
proceeds summary, and never shows an amount without its person.

## Decision

1. **The payment select carries the payer** (`userId`), and a pure
   `scopeAppointmentDetail(detail, viewerUserId, privileged)` filters the
   rows to the viewer's own unless the viewer is the plan's consultant, an
   accepted collaborator, or platform staff. `authorizeAppointment` applies
   it on the participant branch; the consultee page applies it before
   hydrating the query cache, so the server-rendered first paint matches
   what the route answers.

2. **The host of a webinar or class sees a summary, not rows** — "4 of 10
   seats paid · ₹12,970.80 collected · 1 lapsed" — and a payment dot on each
   participant chip. `lib/appointments/seat-payments.ts` picks the row that
   speaks for a seat (paid over pending over failed over expired, then the
   newest) so the detail page and the roster cannot disagree.

3. **The roster's status column is the seat's payment.** Both participants
   routes return `seatPayments`; a seat with no Payment row says "No
   payment" rather than pretending.

4. **A kind declares its capabilities** in
   `lib/appointments/kind-capabilities.ts`. The Documents block renders only
   for kinds that support documents; a webinar no longer fetches, fails, and
   then promises uploads once the booking is confirmed.

## Consequences

An attendee's detail payload is smaller and contains no other attendee's
money. The 1:1 kinds render exactly as before. The org operator's page is
unchanged: it takes the attending side's adapter and now receives the
attendee's own rows through the same route.

What stays open: the header can say "Cancelled" while a session row says
"COMPLETED" on seed data whose slot status was never reconciled with the
booking status; that is a seed defect, not a rendering one, and the reset
clears it. A receipt or invoice link on the attendee's own payment row
belongs with the consumer-invoice work (#438).
