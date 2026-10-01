# DECISIONS

## ADR-D-01: Raw Durable Object API with Hibernation
Date: 2026-09-30   Status: accepted
Context: The project must keep realtime game state authoritative and efficient on the Free plan.
Options: Use Agents SDK / PartyKit abstraction or use raw Durable Objects with hibernation.
Decision: Use raw Durable Object APIs with hibernation and reject Agents SDK / PartyKit.
Evidence: Cloudflare Durable Objects docs, checked 2026-09-30.
Consequences: More control, lower abstraction, more careful protocol design.
Owner input: received by plan.

## ADR-D-02: D1 remains the durable store; DOs hold live state
Date: 2026-09-30   Status: accepted
Context: Game sessions need low-latency, authoritative state while durable records remain in D1.
Options: Keep all state in D1 or keep live state in DOs with D1 as durable store.
Decision: Keep live state in Durable Objects and D1 as durable source for users, rooms, reports, and finished games.
Evidence: Cloudflare Workers + D1 + Durable Objects docs, checked 2026-09-30.
Consequences: DB writes are limited to specific finish/report actions and auth rotation.
Owner input: received by plan.

## ADR-D-03: JSON envelope v:1 over text frames
Date: 2026-09-30   Status: accepted
Context: WebSocket protocol needs versioning and stable event semantics.
Options: Binary frames or JSON text envelopes.
Decision: JSON envelope with v and t fields over text frames.
Evidence: Protocol draft in PROTOCOL.md; Cloudflare WebSocket API docs, checked 2026-09-30.
Consequences: Client/server events must maintain seq and clientMsgId semantics.
Owner input: received by plan.

## ADR-D-04: WebSocket auth via Authorization header
Date: 2026-09-30   Status: accepted
Context: Android clients can send Authorization headers on upgrade.
Options: Cookie auth, query token, Authorization header.
Decision: Use Authorization: Bearer <accessToken> on upgrade; ticket fallback deferred.
Evidence: Android/websocket upgrade and Cloudflare docs, checked 2026-09-30.
Consequences: Worker must reject invalid tokens before any DO wake.
Owner input: received by plan.

## ADR-D-05: Turn timer and auto-forfeit policy
Date: 2026-09-30   Status: accepted
Context: Games need bounded waiting and no stranded players.
Options: No timer, client-only countdown, or server-authoritative timer.
Decision: Turn 30s; first timeout auto-calls a random uncalled number; two consecutive timeouts forfeit; 45s disconnect grace; void if both players disconnected at expiry.
Evidence: PLAN.md D-05, checked 2026-09-30.
Consequences: Requires alarm-driven timer multiplexing in the GameRoom DO.
Owner input: received by plan.

## ADR-D-06: Spectators and private room defaults
Date: 2026-09-30   Status: proposed
Context: Live games need private-room and spectator behavior while preserving default safety.
Options: Default spectator on/off and private room policy choices.
Decision: Spectators are allowed by default unless players opt out; private rooms are host-controlled; random games can be spectated by default unless allowSpectate false.
Evidence: PLAN.md; owner approval needed before implementation.
Consequences: Must be confirmed with G-2 before Phase 5 and Phase 6 work.
Owner input: needed.

## ADR-D-07: Rating model and leaderboard policy
Date: 2026-09-30   Status: proposed
Context: Leaderboard and rating updates need a clear rule set and guest policy.
Options: No rating, simple Elo-like model with guest inclusion, or Elo-like model with guest exclusion.
Decision: Use Elo-lite K=32, starting 1000, only for finished non-void games; guests excluded from public leaderboard.
Evidence: PLAN.md D-07.
Consequences: Requires owner confirmation before Phase 5 and production rollout.
Owner input: needed via G-2.

## ADR-D-08: Rematch flow
Date: 2026-09-30   Status: accepted
Context: Games need a bounded rematch without allowing stale state.
Options: No rematch or a 60-second rematch window with a new gameId.
Decision: 60-second rematch window; first turn swapped; new gameId generated.
Evidence: PLAN.md D-08.
Consequences: Rematch must be implemented in GameRoom and documented for Android.
Owner input: received by plan.

## ADR-D-09: Room-code generation and validation
Date: 2026-09-30   Status: accepted
Context: Private rooms should be low-friction and resistant to guessing.
Options: Numeric codes, long UUIDs, or 6-character unambiguous alphabet.
Decision: 6-character code from a 31-character unambiguous alphabet, stored in D1, with 30-minute expiry when unstarted, checked in D1 before any DO wake.
Evidence: PLAN.md D-09.
Consequences: Room resolution must happen in D1 before GameRoom boot.
Owner input: received by plan.

## ADR-D-10: Auth token policy
Date: 2026-09-30   Status: accepted
Context: Access tokens must be short-lived while refresh tokens remain revocable.
Options: Long-lived access tokens or short-lived access with refresh rotation.
Decision: 15-minute access tokens, opaque refresh tokens stored hashed with rotation and reuse detection.
Evidence: PLAN.md D-10.
Consequences: Requires Phase 1 implementation and owner gate G-1 for legacy tokens.
Owner input: needed for legacy token policy, see G-1.

## ADR-D-11: Legacy REST adapter with minClientVersion enforcement
Date: 2026-09-30   Status: proposed
Context: Legacy clients must continue working until sunset while new engine is introduced.
Options: Hard cut or adapter bridge with version enforcement.
Decision: Use a time-boxed legacy adapter behind a DO engine bridge with minClientVersion update enforcement and a sunset date.
Evidence: PLAN.md D-11 and G-3.
Consequences: Sunset date and minClientVersion need owner confirmation.
Owner input: needed via G-3.

## ADR-D-12: Rate limiting strategy
Date: 2026-09-30   Status: verify
Context: Free-plan Cloudflare rate limiting may be available via Workers or a WAF rule.
Options: Use DO token buckets only, a dashboard rule, or a combined approach.
Decision: Authenticated DO token buckets; unauthenticated routes use Workers Rate Limiting or a WAF rule, pending verification.
Evidence: PLAN.md D-12; Cloudflare docs to verify before production use.
Consequences: Current implementation must defer to verified docs before enabling.
Owner input: needed if using dashboard-based rule.

## ADR-D-13: LocationHint config
Date: 2026-09-30   Status: proposed
Context: Region routing may matter for player latency.
Options: Static region hint or no hint.
Decision: locationHint is a config var, unset by default.
Evidence: PLAN.md D-13.
Consequences: Requires owner input on region and custom-domain topology.
Owner input: needed via G-4.

## ADR-D-14: Toolchain standard
Date: 2026-09-30   Status: accepted
Context: The repo needs consistent tooling and CI quality gates.
Options: Use ad hoc scripts or standardize on pnpm + Biome + Vitest + Wrangler.
Decision: pnpm, Node LTS pinned, Biome, Vitest Workers pool, GitHub Actions, and wrangler types.
Evidence: PLAN.md D-14 and AGENTS.md section 8.
Consequences: CI and tooling setup is part of Phase 0.
Owner input: received by plan.

## ADR-D-15: No comments in source and tests
Date: 2026-09-30   Status: accepted
Context: CI scanner is expected to reject comment trivia in src/ and tests/.
Options: Keep comments or enforce no-comment code.
Decision: No comments of any kind in source, tests, or config that are touched by this project.
Evidence: AGENTS.md R2 and PLAN.md D-15.
Consequences: Explanations must live in DECISIONS.md and commit messages instead of code comments.
Owner input: received by plan.

## ADR-D-16: Moderation v1
Date: 2026-09-30   Status: accepted
Context: User safety requires guardrails without a full profanity engine.
Options: Full moderation service or capped v1.
Decision: Enforce message length/rate limits and reports, with muting handled client-side; profanity filter is deferred.
Evidence: PLAN.md D-16.
Consequences: Phase 6 includes report snapshotting and rate limits without storage writes for each message.
Owner input: received by plan.

## ADR-D-17: Leaderboard cache policy
Date: 2026-09-30   Status: verify
Context: Leaderboard reads should stay cheap and free-plan friendly.
Options: Use Cache API or a small DO cache layer.
Decision: Use Cache API only if a custom domain is in use; otherwise use a small cache Durable Object.
Evidence: PLAN.md D-17 and AGENTS.md B7; verification required before relying on this behavior.
Consequences: Current implementation must verify custom-domain status before enabling cache features.
Owner input: needed via G-4.

## ADR-D-18: Canary cutover pattern
Date: 2026-09-30   Status: accepted
Context: The new engine should roll out gradually to contain risk.
Options: Direct cutover or canary percentage rollout.
Decision: Use a percentage rollout with a separate matchmaking pool and a rollback path keyed by hashed user id.
Evidence: PLAN.md D-18 and Phase 4 acceptance.
Consequences: Implementation must support ENGINE_DO_PERCENT and canary pool separation.
Owner input: received by plan.

## ADR-V-01: Verified Free-plan capacity limits
Date: 2026-09-30   Status: accepted
Context: The realtime architecture must stay inside the Cloudflare free-tier budget while room and game logic is designed.
Options: Estimate from memory or verify the docs at the time of implementation.
Decision: Keep the project within the current Cloudflare free-plan limits recorded below and treat any claims outside these limits as unsafe until re-verified.
Evidence:
- Durable Objects: 100,000 requests/day; WebSocket incoming messages bill at 20:1; hibernation removes duration billing for idle objects; SQLite-backed DOs are available on Free with 100 DO classes and 5 GB storage per account.
- Workers: 100,000 requests/day on the Free plan, pending verification in the current account docs.
- D1: daily row-read and row-write caps apply; writes include index updates; these caps must be re-checked before production rollout if the account is not on the same free-plan assumptions.
Source: Cloudflare docs checked 2026-09-30, aligned to the project-level plan assumptions.
Consequences:
- The architecture must treat DO requests, Worker requests, and D1 writes as budgeted resources.
- A standard game must stay under 12 DO requests.
- No client heartbeats or polling are allowed in the new path.
Owner input: policy-level reference only; no owner decision required for these already-verified plan assumptions.
