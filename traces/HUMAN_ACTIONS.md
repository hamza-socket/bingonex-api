# HUMAN ACTION REQUESTS

### HAR-01: Verify the production JWT secret
Needed before: Phase 0, before deployment or fail-closed auth changes
Why: The repo currently has a hardcoded fallback in auth logic; the real secret must be checked before production rollout.
Steps:
1. Owner runs: wrangler secret list
2. Owner confirms whether a JWT secret exists in the production environment.
3. If absent, treat the system as compromised and follow HAR-02.
Verify: Output shows the production secret name(s) or confirms no secret is present.
Rollback: Stop rollout and keep the app in a fail-closed default until the secret is configured.
Status: open

### HAR-02: Set or rotate JWT_SECRET before production deploy
Needed before: Phase 0 deploy after G-0 answer
Why: Security hardening requires no default secret and fail-closed behavior.
Steps:
1. Owner runs: wrangler secret put JWT_SECRET --env production
2. Owner stores the secret in the managed Cloudflare environment.
3. Confirm the app reads the environment value only; never commit any secret in code or trace files.
Verify: Cloudflare shows the secret as set and the app starts without a fallback.
Rollback: Revert to the fail-closed branch only if the secret is not usable.
Status: open

### HAR-03: Back up D1 before remote migration
Needed before: Phase 1 or any remote migration action
Why: The project uses expand-only migrations and must preserve data before any D1 change.
Steps:
1. Owner runs: wrangler d1 export <database_name> --output ./d1-backup.sql
2. Owner verifies the export file exists and is retained.
3. Review D1 Time Travel retention on Free before any remote migrations.
Verify: Backup output is created and stored outside the repo.
Rollback: Abort the migration if the export fails or is incomplete.
Status: open

### HAR-04: Apply migrations remotely
Needed before: Phase 1 migrations to production
Why: Local migration validation is safe, but production D1 changes require an explicit owner action.
Steps:
1. Owner runs: wrangler d1 migrations apply <database_name> --remote
2. Owner confirms the migration is additive only.
Verify: Wrangler reports success with zero destructive SQL statements in the migration set.
Rollback: Undo only via a new, approved expansion or a rollback plan documented in DECISIONS.md if the owner approves it.
Status: open

### HAR-05: Deploy the app
Needed before: Phase 0 or later production rollout
Why: Deployment must happen only after environment config and migration checks are complete.
Steps:
1. Owner runs: wrangler deploy
2. Owner confirms the production deployment mode matches Durable Object migration support.
Verify: Deployment logs show a successful versioned release.
Rollback: Set the rollout percent to 0 and revert the app version if required.
Status: open

### HAR-06: Set runtime vars
Needed before: production engine rollout
Why: ENGINE, ENGINE_DO_PERCENT, MAX_ACTIVE_GAMES, and LOCATION_HINT must be set explicitly.
Steps:
1. Owner runs the required wrangler vars set commands for the production environment.
2. Owner verifies each value is intentional and non-default where required.
Verify: wrangler env list or equivalent output shows the configured variables.
Rollback: Remove or reset the variable to the safe default value.
Status: open

### HAR-07: Configure rate limiting or WAF if required
Needed before: Phase 1 unauthenticated rate limiting decisions
Why: D-12 depends on the actual Cloudflare product available to the account.
Steps:
1. Owner checks whether Workers Rate Limiting or a WAF rule is available for the project.
2. Owner configures the selected dashboard rule if required.
Verify: Dashboard shows the rate limit rule is active and associated with the correct route set.
Rollback: Remove the rule or disable the affected protection if it breaks service.
Status: open

### HAR-08: Review daily usage report
Needed before: rollout and each future phase gate
Why: Free-plan quotas can fail live traffic if usage is not monitored.
Steps:
1. Owner checks the daily Cloudflare report for DO, Worker, and D1 usage.
2. Owner confirms the project remains below the daily limits.
Verify: Usage report shows values within the expected thresholds.
Rollback: Reduce rollout percent or suspend non-essential live traffic until limits are safe.
Status: open
