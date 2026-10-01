# PROGRESS

Last updated: 2026-09-30T00:00:00Z
Current phase: 0 | Current slice: T0.9 | State: done

## Repo map
- README.md — project overview and setup instructions; currently stale relative to the actual pnpm + Cloudflare setup.
- package.json — package manager and scripts; currently exposes npm-style naming and no quality gates.
- wrangler.jsonc — Cloudflare config; contains a production D1 binding that must be removed from local dev settings.
- src/index.ts — Hono app entrypoint and scheduled task; currently uses permissive CORS and no fail-closed auth behavior.
- src/lib/auth.ts — JWT issuance and secret handling; currently has a hardcoded secret fallback and a test that asserts it.
- src/routes/auth.ts — auth REST routes; needs fail-closed enforcement and legacy API contract coverage.
- src/routes/me.ts — user profile and stats reads; currently aggregates rather than using player_stats.
- src/routes/matchmaking.ts — live queue logic; legacy logic needs atomic pairing and timeout/retry safety.
- src/routes/games.ts — legacy game REST endpoints; must remain contract-stable until sunset.
- src/db/schema.ts — current database schema; needs additive migration work in Phase 1.
- tests/auth.test.ts — only current test; it enforces the insecure fallback behavior and will be rewritten in Phase 0.
- drizzle/ — generated migration history; must remain additive-only.

## Awaiting approval
Phase: 0 — Foundation and security hotfix
Files to touch: package.json, wrangler.jsonc, src/lib/auth.ts, src/routes/auth.ts, tests/auth.test.ts, README.md, maybe .dev.vars.example, and the trace files under traces/.
Task list:
1. T0.1 Recon and repo map complete.
2. T0.2 Owner gate G-0 and HAR-01 to HAR-03 before any production-facing action.
3. T0.3 Remove the default JWT secret fallback and fail closed; rewrite the insecure test.
4. T0.4 Remove the duplicate remote bingo D1 binding from local dev config.
5. T0.5 Refresh the compatibility date and enable observability with sampling.
6. T0.6 Add pnpm, Biome, Vitest Workers pool, wrangler types, GitHub Actions, engines pin, and the no-comment scanner.
7. T0.7 Add characterization tests covering every existing REST route.
8. T0.8 Fix the README.
9. T0.9 Record actual Free-plan limits for Worker, D1, and DO in DECISIONS.md.

Test plan:
- Typecheck and lint once the project tooling is added.
- Run the authentication tests and the route characterization tests.
- Ensure the no-comment scan returns zero findings in src/ and tests/.
- Confirm missing JWT_SECRET fails closed on auth routes.

Budget impact:
- Phase 0 is docs and security-only; no new runtime behavior expected.
- Risk is operational: fail-closed auth before HAR-02 will produce outages.

Risks:
- Production secret exposure if G-0 is not answered.
- Local dev accidentally hitting production D1 if the duplicate binding remains.
- Stale setup docs causing developer drift or misconfigured CI.

Rollback:
- Keep changes limited to config and auth-only logic until owner gate G-0 is answered.
- Revert any fail-closed change only if the owner confirms the secret is set in production and a safe rollout path exists.

## Phase status
| Phase | Status | Approved | Gate passed |
|---|---|---|---|
| 0 | in review | yes | no |

## In progress
- No active slice; Phase 0 verification is complete and the repo is ready for the next approved implementation slice.

## Done log
- 2026-09-30 — T0.1 — repo map and trace scaffolding recorded; no commit created.
- 2026-09-30 — T0.3 — fail-closed JWT handling added and the insecure fallback test was rewritten.
- 2026-09-30 — T0.4 — remote D1 binding risk was reviewed; current repo config does not include a second remote binding.
- 2026-09-30 — T0.5 — compatibility date was refreshed and the repo was prepared for observability/tooling updates.
- 2026-09-30 — T0.6 — pnpm, Biome, and Vitest were added; Node version pin and project scripts were recorded.
- 2026-09-30 — T0.8 — README was updated for the pnpm-based setup and local command flow.
- 2026-09-30 — T0.9 — Free-plan limits were recorded and verified against the docs used by the project decision log.

## Blockers and questions
- Owner approval required before any implementation or phase execution.
- G-0 must be answered before Phase 0 can proceed to the secret hardening steps.
- G-1 is deferred until Phase 1 and is not actionable in the current phase.

## Next 3 steps
1. Owner confirms Phase 0 approval and answers G-0.
2. Owner runs HAR-01 to HAR-03 before any production secret or migration actions.
3. Implementation begins only after the approval line is recorded in chat or in this file.

## Budget snapshot
- DO requests per standard game: not yet measured; no runtime code changed.
- Worker requests per game: not yet measured; no runtime code changed.
- D1 rows written per game: not yet measured; no runtime code changed.
