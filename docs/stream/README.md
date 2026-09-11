# Stream

Stream provides two products in this application under a single API key. Stream
Chat backs direct messages, event channels and collaborator threads. Stream
Video backs the meeting rooms. They share a user store, a JWT signing secret and
a token-revocation flag, but they bill separately — Chat by monthly active user,
Video by participant-minute — so a change that looks free on one side can be
expensive on the other.

Three files linked here for some time before this index existed. It exists now,
and it is also the place to record what these documents are and are not.

## Read the code before you trust a document

This subsystem has repeatedly looked correct in code and been broken in
production, and the documents here have drifted from the implementation more
than once. The 2026-08-12 audit recorded in #1134 found a webhook pipeline that
had never once run, because the signing secret was simply not set in Netlify —
nothing in any file here would have revealed that.

The two most reliable documents are `03-provider-authentication.md` and
`troubleshooting.md`. Where a document and the code disagree, the code is
correct and the document is a bug worth fixing in place.

Verify against the live application rather than against these pages when the
answer matters:

```
mcp__streamio__video_query_calls    {"ended_at": {"$exists": false}}
mcp__streamio__chat_query_channels  {"type": {"$eq": "messaging"}}
netlify env:list --json
```

## The documents

The numbered files are meant to be read in order by someone new to the
subsystem. The unnumbered ones are references.

| Document                                                                   | What it covers                                                    |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [00-pricing-overview.md](./00-pricing-overview.md)                         | What Stream costs and which meter each feature runs against.      |
| [01-architecture.md](./01-architecture.md)                                 | How the pieces fit together, with the meeting-join flow.          |
| [02-setup-configuration.md](./02-setup-configuration.md)                   | Environment variables, dashboard configuration and the call type. |
| [03-provider-authentication.md](./03-provider-authentication.md)           | Client connection, the provider, and the initialization sequence. |
| [04-chat-implementation.md](./04-chat-implementation.md)                   | Channel shapes, and how a direct-message id is derived.           |
| [05-video-implementation.md](./05-video-implementation.md)                 | Meeting rooms, call lifecycle and the lobby.                      |
| [06-channel-management.md](./06-channel-management.md)                     | Who may talk to whom, and how membership is reconciled.           |
| [07-user-management.md](./07-user-management.md)                           | Upserting users into Stream and keeping them in step.             |
| [08-token-management.md](./08-token-management.md)                         | Minting, scoping and revoking tokens.                             |
| [09-background-sync.md](./09-background-sync.md)                           | The stale-user sweep and its schedule.                            |
| [10-api-endpoints.md](./10-api-endpoints.md)                               | The routes this subsystem exposes.                                |
| [11-hooks-utilities.md](./11-hooks-utilities.md)                           | Client hooks and the shared helpers.                              |
| [12-error-handling.md](./12-error-handling.md)                             | The circuit breaker, failure modes and what surfaces to users.    |
| [13-recording-webhooks.md](./13-recording-webhooks.md)                     | Recording lifecycle, storage transfer and the webhook handlers.   |
| [14-pricing-and-cost-model.md](./14-pricing-and-cost-model.md)             | The cost model in detail, with worked figures.                    |
| [15-enterprise-and-maker-account.md](./15-enterprise-and-maker-account.md) | Plan tiers and what the Maker account includes.                   |
| [16-product-concepts-and-addons.md](./16-product-concepts-and-addons.md)   | Stream's own product vocabulary and its paid add-ons.             |
| [troubleshooting.md](./troubleshooting.md)                                 | Symptoms and their causes, kept current.                          |
| [stream-ecosystem.mmd](./stream-ecosystem.mmd)                             | A diagram of the whole subsystem.                                 |

## Rules that have been learned the hard way

Each of these cost an incident. They are repeated in the `stream` skill (`.claude/skills/stream/SKILL.md`),
which is the version kept closest to the code.

**Never derive an identifier with `localeCompare`.** It orders by ICU collation,
which is locale- and build-dependent, so two environments produce different
identifiers from the same inputs. Use code-unit ordering: `a < b ? [a, b] : [b, a]`.
A commit that "standardized" this to `localeCompare` silently re-keyed every
mixed-case direct-message pair and orphaned their history. All identifier
derivation goes through `lib/stream-channel-ids.ts` and `lib/stream-utils.ts`,
and the ceiling is 64 characters.

**Always pass `iat` when minting a token.** Stream treats a token with no `iat`
as invalid once `revoke_tokens_issued_before` is set for that user, so a token
minted without one plus a single ban equals a permanent lockout.

**Webhooks must be acknowledged first.** Stream retries within a fifteen-second
total budget and then drops the event permanently. Verify the signature,
persist the receipt, acknowledge, and do the work afterwards. Use the
`X-Webhook-ID` header for idempotency, because a key built from `created_at`
collides.

**Never await a Stream call inside a database transaction**, and never leave
channel provisioning as a floating promise. The function can freeze before it
settles.

**Chat state does not live in Postgres.** Channels exist only on Stream, which
is why a bad channel-identifier derivation is unrecoverable data loss rather
than a bug you can migrate your way out of.

**Development, preview and production currently share one Stream application.**
A test deletion is a real deletion.

## Related

- Issue #1134 — the audit that produced most of the current state of this
  subsystem, and the tracker for what remains.
- Issue #1146 — the review findings that outlived the pull requests that raised
  them.
- [ADR: `resolveMeetingAccess` returns what it loaded](../decisions/2026-08-13-meeting-access-returns-what-it-loaded.md)
- `.claude/skills/stream/SKILL.md` — the working reference, kept in step
  with the code more actively than these pages.
