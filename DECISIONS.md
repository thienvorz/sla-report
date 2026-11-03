# DECISIONS

## What I assumed

- The report's `from` and `to` dates are compared with each request's creation date in that request site's IANA timezone, inclusive, as the contract specifies.
- When events share the same Unix timestamp, I use event ID as a deterministic ordering tie-breaker. The rules do not define same-second event ordering.
- `due_at` is a site-local wall-clock deadline. The rules do not specify how to resolve a deadline in a repeated daylight-saving hour; this edge still needs a defined policy and verification.
- I added `priority` as an optional `/api/requests` filter because browsing requirements asked for it. It is not listed in `docs/contract.md`; the contract should be updated or the extension removed to avoid conflicting with the rule that unknown parameters are ignored.

## What I found in the API or data

- `docs/api.md` documents `/v1/changes` as a change feed with `next_cursor`, `has_more`, and a maximum page limit of 500. It documents duplicate feed items, request payloads containing the request's current state, and expired cursors returning `410`. No webhook is documented, so the app polls the feed.
- The docs represent request `created_at` as an ISO timestamp, event `at` as Unix seconds, and event `due_at` as a site-local `DD/MM/YYYY HH:mm` value. Sites provide their own timezone, business hours, and holidays; staff names come from `/v1/staff`.
- The local fixtures cover null priorities, system events with no actor, reverted and duplicate events, site-specific timezones, a spring-forward DST schedule, and missing response/deadline cases. They are test fixtures, not a complete audit of live practice data. Overnight business hours and fall-back DST deadline behavior should be checked against the live site metadata and clarified where the docs are ambiguous.

## How I used AI

- I used OpenAI Codex to inspect the assignment docs and code, implement reporting and synchronization, add tests, and review the result.
- Codex initially used flat source paths after the project had been organized under `controllers`, `domain`, `services`, and `store`. I corrected those imports and reran the provided test command; all 28 tests passed.
- A practice API credential was briefly placed in `.env.example` during setup. I restored that file to blank placeholders before committing. The real `.env` is ignored and was not included in the commits.

## Trade-offs and what I would do next

- The app uses in-memory maps for reporting and an atomically replaced JSON snapshot plus a separate cursor checkpoint for persistence. This keeps the take-home deployable with one container and no database, but each data-changing sync rewrites the snapshot and this approach is intended for a single writer.
- The change feed is polled every 20 seconds, with retry handling for rate limits and transient server errors. The cursor and report-row caches are in memory; a restart reloads persisted helpdesk state but starts with empty report caches.
- I would next compare a report against a full live API sample, verify site-specific holidays and timezone edge cases (especially DST fall-back and overnight hours), and add a bounded upstream request timeout plus cursor-cache limits. I would also benchmark with the full expected request and event volume and resolve the documented `priority` filter discrepancy.
