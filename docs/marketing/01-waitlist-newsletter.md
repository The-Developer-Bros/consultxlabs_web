# Waitlist (Newsletter)

## What this is

The waitlist is the platform's marketing email list. A visitor enters an email
address, confirms it, and receives occasional broadcasts from Familiarise. The
model is called `Waitlist` because that is the phrase the signup uses in the
product; internally it is an ordinary double opt-in mailing list.

This subsystem has nothing to do with event capacity. An earlier version of the
`Waitlist` model was a priority queue for full webinars and classes, complete
with a 48-hour "a spot opened" offer and a seat hold. That design was retired:
group events now show a plain sold-out state, and the organizer controls how
many people are allowed in. Capacity is documented in
[the booking capacity guide](../booking/02-event-types-and-validation.md).

## Data model

The model lives in `prisma/schema.prisma` alongside the two enums it uses.
There are no token columns, because both the confirmation link and the
unsubscribe link are stateless HMACs.

| Field | Type | Notes |
| --- | --- | --- |
| `email` | `String @unique` | Always stored lowercased and trimmed. |
| `name` | `String?` | Optional; only some surfaces collect it. |
| `status` | `WaitlistStatus` | `PENDING`, `SUBSCRIBED`, `UNSUBSCRIBED`, `BOUNCED`. |
| `source` | `WaitlistSource` | Which surface the signup came from. |
| `tags` | `String[]` | Free-form segmentation labels. |
| `userId` | `String?` | Set when a signed-in user subscribes; `SetNull` on delete. |
| `confirmedAt` | `DateTime?` | Set when the confirm link is clicked. |
| `unsubscribedAt` | `DateTime?` | Set on opt-out. |
| `consentIpHash` | `String?` | SHA-256 of the request IP, salted with the HMAC secret. |
| `consentUserAgent` | `String?` | Truncated to 500 characters. |

The raw IP is never stored. Under DPDP the platform needs to be able to show
that a given address consented, and a salted digest plus a user agent and a
timestamp is enough to do that without retaining a plain identifier.

## Double opt-in

A signup does not put anyone on the list. It writes a `PENDING` row and sends a
confirmation email; only clicking the link in that email flips the row to
`SUBSCRIBED` and triggers the welcome message. This protects the sending
domain's reputation, which matters because every transactional email on the
platform goes through the same Resend account.

An address that had previously unsubscribed goes back to `PENDING`, not
straight to `SUBSCRIBED`. Re-consent has to be an explicit click rather than a
side effect of somebody re-entering an address in a form.

## Tokens and secrets

`lib/waitlist/tokens.ts` signs both link types with an HMAC over
`purpose|email|issuedAt`. Binding the purpose into the signature is what stops
a confirmation link from being replayed as an unsubscribe link.

Confirmation links carry their issue time in the URL and expire after 48 hours.
Unsubscribe links deliberately never expire: an unsubscribe link in a two-year
old email still has to work, and RFC 8058 one-click depends on it.

The signing key is `WAITLIST_HMAC_SECRET`. It has no fallback in production. An
earlier version fell back to `RESEND_API_KEY`, which meant that rotating the
Resend key silently invalidated every unsubscribe link that had ever been sent.
In development an unset secret falls back to a fixed string so the flow is
testable without configuration.

## Routes

| Route | Purpose |
| --- | --- |
| `POST /api/waitlist` | Public signup. Rate limited to three requests per hour per IP in `middleware.ts`. |
| `GET /api/waitlist/confirm` | Double opt-in landing page. |
| `GET /api/waitlist/unsubscribe` | The link in an email footer; renders a confirmation page. |
| `POST /api/waitlist/unsubscribe` | RFC 8058 one-click, used by Gmail and Outlook's native unsubscribe button. |
| `GET /api/admin/waitlist` | Backoffice subscriber list. `?format=csv` exports the same filtered set. |
| `POST /api/admin/waitlist/broadcast` | Sends one newsletter to every confirmed subscriber. |

The public endpoints are deliberately enumeration-safe. Signing up with an
address that is already subscribed returns the same response as a fresh signup,
and unsubscribing with an invalid token renders the same page as a successful
one. Anything else would turn these routes into a membership oracle for
arbitrary addresses.

## Sources and tags

`WaitlistSource` records which surface a signup came from, so the admin list can
tell a footer signup apart from a blog signup. `tags` is free-form and intended
for manual segmentation. Neither field drives behaviour today; both exist so
that a future segmented send does not require a migration.

## Sending

Broadcasts go out through Resend's batch API in groups of a hundred. Every
message gets an unsubscribe footer appended and carries the `List-Unsubscribe`
and `List-Unsubscribe-Post` headers that let mail clients offer a one-click
opt-out. When a batch fails, each message in it is dead-lettered through
`recordFailedEmail` so the retry worker can replay it; the previous
implementation only counted the failure and dropped the content.

The transactional confirm and welcome emails live in `lib/email.ts` with the
rest of the platform's senders, and follow the same pattern: build the rendered
message before sending, check `data.error` because Resend resolves rather than
throws on API errors, and dead-letter on failure.

## Administration

The backoffice surface is `waitlist.manage`, granted to staff and admins, and it
renders at `/dashboard/admin/waitlist` and `/dashboard/staff/<id>/waitlist`. It
lists subscribers with status and source filters, a search over email and name,
a CSV export, and the compose form that drives the broadcast route.

## What is deliberately absent

There is no integration with an external email service provider. ConvertKit was
scaffolded once and never wired up; the stub has been removed and the list lives
in Postgres with Resend as the transport.

Sold-out events do not capture emails. That was considered and rejected: sold
out means sold out, and the organizer raising the capacity is the mechanism for
letting more people in.
