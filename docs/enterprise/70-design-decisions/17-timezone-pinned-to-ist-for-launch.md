---
title: Timezone handling pinned to IST for launch; full DST and IANA-TZID work deferred
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-06-15
---

# ADR 17 — Timezone handling pinned to IST for launch

## Context

Every consultant on the platform today operates in India Standard Time, which
does not observe daylight saving. Despite that, the slot model had begun to
carry a half-built "DST-proof source of truth": `SlotOfAvailabilityWeekly` had
gained nullable `timezone`, `localStartMinutes`, `localEndMinutes`,
`localStartDay`, and `localEndDay` columns, populated at write time by
`utils/slotAllocation/localTime.ts`, alongside a backlog of seven timezone
hardening items (#503) and a deferred evaluation of the JavaScript `Temporal`
API (#502). The local columns were written but never read — the read-side
migration that would use them was itself deferred — so they were carrying
risk and implying a DST-safety the code did not actually provide.

## Decision

Timezone handling is pinned to a single non-DST zone, Asia/Kolkata, for launch.
The frozen `utcOffsetMinutes` on each weekly slot is the source of truth and is
correct at `+330` for every consultant the platform has. The core slot math
stays: the overnight resolver (`utils/schedule/overnight.ts`), the `Intl`-based
offset lookup, and all `formatInTimeZone` display formatting are needed in any
timezone and are unaffected.

The schema is finalized now, but the implementation is deferred. The five
RFC 5545 columns (`timezone`, `localStartMinutes`, `localEndMinutes`,
`localStartDay`, `localEndDay`) stay on `SlotOfAvailabilityWeekly`, frozen into
the launch schema so that going DST-aware later needs no production migration;
they are left nullable and unwritten. This representation — a local wall-clock
window plus the IANA zone, materialized to UTC per occurrence — is the one
Calendly, Cal.com, and RFC 5545 all use, and it is precisely what a frozen
offset cannot do, since the offset is wrong half the year in any DST zone. What
is removed is the half-built implementation that surrounded those columns:
`localTime.ts` and the write-side population. Populating columns that nothing
reads added complexity and a false impression of DST-safety for a condition
that cannot occur while the platform is IST-only, and the removal is
regression-safe because the population was write-only and the allocation math
reads `utcOffsetMinutes`, not these columns. The call sites carry `TODO(#872)`
markers where the implementation will be restored.

The full timezone implementation — storing each slot's local wall-clock window
plus its IANA TZID and materializing UTC per occurrence, the seven #503
hardening items, and the #502 `Temporal` evaluation — is consolidated into a
single post-MVP issue, #872, which supersedes #503 and #502. It is revisited
when the first consultant in a daylight-saving timezone onboards, at which point
the frozen offset stops being sufficient and the local-plus-zone representation
becomes load-bearing.
