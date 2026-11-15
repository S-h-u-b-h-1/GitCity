# GitCity — optional durable public-city cache rollout

This is an **opt-in, public-only** cache for source-derived city maps. It is not
an authentication system, not browser-workspace persistence, and not a way to
access private repositories.

## Current production default

- Vercel hosts the static GitCity UI.
- Render Free hosts one FastAPI worker, with anonymous sessions, quotas, saved
  user workspaces and the short-lived shared cache in temporary SQLite.
- Public graph cache: 8 minutes in RAM, up to 12 hours in temporary SQLite.
- GitCity operates normally with **no PostgreSQL connection configured**.

## Preconditions before enabling PostgreSQL

1. Obtain a clear spending limit/approval. The connected Neon organization is
   on a **usage-billed Launch plan**. Do not provision a database or attach an
   existing project without permission and budget controls.
2. Create a dedicated GitCity database and least-privilege role. Do not use
   Mindfield, Rashtram, or any unrelated application's existing database.
3. Apply `scripts/gitcity_public_cache.sql` to the dedicated database.
   The runtime deliberately does **not** attempt DDL during requests.
4. Use a server-side TLS connection string. Configure
   `GITCITY_PUBLIC_CACHE_DATABASE_URL` **only on Render**, not Vercel's static
   frontend and never in a tracked file.
5. The role needs only `SELECT, INSERT, UPDATE, DELETE` on the one table after
   the administrator creates the schema. Do not grant it access to other data.
6. Perform the rollout during a maintenance window: changing Render environment
   variables redeploys the Free service and can erase its temporary SQLite
   sessions, workspaces and current quota state.

## Behavior and scope

- Read path: validated 8-minute RAM cache → ephemeral 12-hour SQLite cache →
  optional TLS PostgreSQL cache → fresh public GitHub fetch.
- Fresh source imports write to SQLite and attempt a best-effort PostgreSQL
  upsert. A PostgreSQL failure is logged **without credentials**, and normal
  public GitHub importing continues.
- PostgreSQL stores only `repo_key`, `graph_json` and `cached_at`. Graphs
  are limited to 500 KB; at most 128 are retained for up to 12 hours.
- A validated cloud cache hit is memoized briefly in RAM and does not consume
  a new GitHub source-import quota. Each browser still receives an isolated
  anonymous session and separate saved-repository ID.
- Database connections are explicitly TLS-required and time-bounded. When the
  optional provider fails, the client stops retrying it for 30 seconds to
  avoid imposing repeated connection timeouts.
- The cache is **not a live GitHub visibility check**. Repo visibility,
  deletions and code revisions may change during the retention window.
  Until public-visibility revalidation is implemented and verified, enable
  this option only if serving last-known-public module metadata for up to
  12 hours is acceptable. Treat names and paths as potentially stale.

## Repeatable checks

Without any database configured (ordinary default):

```bash
python -m pytest -q app/tests
node --test app/tests/*.cjs
```

To verify actual SQL against a **disposable** PostgreSQL database:

```bash
# First apply scripts/gitcity_public_cache.sql to the disposable database.
# Use test-only credentials; do not point this at a real application database.
GITCITY_TEST_POSTGRES_DSN="postgresql://<test-role>:<test-secret>@<host>/<test-db>?sslmode=require" \
  python -m pytest -q app/tests/test_public_snapshot_pg_integration.py
```

An isolated PostgreSQL 18 / TLS test verified: first browser fetches mocked
public GitHub source, RAM/SQLite state is then discarded, second browser
recovers the graph from PostgreSQL without another source fetch; cookies and
saved repository IDs remain distinct.

## Release gates

- Python and Node tests green at exact source HEAD.
- Real browser checks for desktop/mobile canonical routes, issue radar, zoom
  reset, source navigation and 72-module dense layout.
- Render `/api/ready` and `/api/health` return HTTP 200 after any backend
  redeploy.
- Confirm explicit PostgreSQL cache hits and compare backend GitHub import
  count before and after enabling the new storage.
- Verify misconfigured/unavailable PostgreSQL does not break imports.
- Do **not** claim unlimited visitors or durable anonymous sessions.

## Rollback

1. Remove `GITCITY_PUBLIC_CACHE_DATABASE_URL` from Render and redeploy.
2. Confirm public GitCity imports use local SQLite and fresh GitHub fallbacks.
3. Keep the separate PostgreSQL table for inspection until a safe retention
   decision. Removing the environment variable does not delete any data.
4. No rollback database migration is required; browser sessions, quota
   counters and existing per-user city snapshots remain SQLite-only.

**Status (15 November 2026): code tested in an isolated environment;
no Neon project created, no paid resource provisioned, and no production
PostgreSQL variable enabled.**
