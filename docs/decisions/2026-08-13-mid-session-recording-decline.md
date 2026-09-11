# ADR: A mid-session recording decline stops the recording and discards it

- **Status**: Accepted
- **Date**: 2026-08-13
- **Author**: teetangh
- **Part of**: #1134, #1146

## Context

#1139 shipped pre-join recording consent. Before it, a consultee's first sign
that a session was being recorded was a small `REC hh:mm` pill that appeared
once recording had already started: no notice, no way to refuse, and no record
that anyone had been told, on a product whose one-to-one sessions are career and
health conversations.

That work deliberately covered one moment only. `lib/stream/recording-consent.ts`
carries an explicit scope note saying enforcement is start-time only, and the
`DECLINED` check lives inside the atomic claim in
`POST /api/stream/recordings/start`, so a decline arriving between the read and
the write loses the race rather than being ignored.

What it does not answer is what happens when someone declines **after** recording
has begun. At that moment a recording of them already exists, and every possible
answer costs something real:

- Discarding it destroys work the consultant may be relying on.
- Keeping it retains a recording of a person who has said they do not want one.
- Refusing the decline tells someone in a health or career conversation that
  their withdrawal of consent does not count.

This is a question about what the platform promises, not about how to implement
it, which is why it sat open in #1146 rather than being decided in code.

## Decision

**A mid-session decline stops the recording immediately and discards what has
already been captured.**

The reasoning is that withdrawing consent means the recording of that person
should not exist. Keeping the portion captured before the decline retains
precisely the artefact they objected to, and the fact that it is shorter than
the full session does not change what it is.

It is also the only answer consistent with what has already shipped. The
one-to-one regime is `OPT_OUT`, and the notice tells people in as many words
that declining is real and costs them nothing: they still join, and the
consultant's recording endpoint refuses. A mid-session decline that quietly kept
a partial recording would make that sentence untrue after the fact.

Group sessions are unaffected. Their regime is `ACKNOWLEDGE`, where the
recording is part of what attendees bought and was disclosed at purchase, and
the only action available is to understand it. There is no decline to honour.

## Consequences

### Positive

- The consent promise means the same thing before and during a session, so the
  pre-join copy stays honest without qualification.
- There is one rule to explain rather than a rule and an exception.
- No retained artefact whose lawful basis depends on reconstructing what someone
  had agreed to at a particular minute.

### Negative

- A consultant can lose an entire session's recording to a decline made in its
  final minutes, with no partial retained. This is a real cost to the person who
  did nothing wrong, and the pre-join copy must say plainly that a decline can
  arrive at any point, rather than implying the decision is settled at join.
- Deletion has to be genuine, which means the discard path must reach Stream's
  stored recording and any transfer already in flight — not merely mark a row.
- Implementation is more than a status flag: it needs an authenticated decline
  during the call, a server-side stop, and a delete that is safe to retry.

### Neutral

- Nothing about the currently shipped behaviour is wrong today. Enforcement is
  start-time only and the source says so explicitly, so this ADR records a
  decision to be built, not a defect to be repaired.

## Alternatives considered

### Stop and keep what was already captured

Rejected. It is defensible in the narrow sense that consent was live while that
portion was recorded, but it leaves the platform holding a recording of someone
who has explicitly said they do not want one, and it makes the answer to "what
do you have of me?" depend on the second at which they clicked. On career and
health conversations that is the wrong side to err on.

### Refuse the decline once recording has started

Rejected. It is the cheapest to build and the easiest to state contractually,
and it is the option most at odds with what the product already tells people.
The notice presents declining as real and free; making it available only until
the moment it matters would be a dark pattern in a consent flow, which is the
exact thing the #1139 design notes set out to avoid when they gave Decline and
Allow equal visual weight.

### Ask the consultant to approve the deletion

Rejected. It makes one participant's consent contingent on another's agreement,
which is not consent.

## Follow-ups

Tracked in #1146. The work is a decline path that is authenticated during the
call, a server-side stop, and a delete that reaches Stream's stored asset and
any in-flight transfer, together with pre-join copy that states a decline can
arrive at any time.

## References

- #1134 — the Stream audit that surfaced the consent gap.
- #1139 — pre-join consent, and the `OPT_OUT` / `ACKNOWLEDGE` split.
- #1146 — remaining items, where the implementation is tracked.
- `lib/stream/recording-consent.ts` — the scope note recording that enforcement
  is start-time only.
