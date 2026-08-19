# Postgres Operations Runbook

One-off procedures against the running `postgres` service that
`db/init/*` only applies automatically on a **fresh volume's first boot**
(`docker-entrypoint-initdb.d` semantics) — an already-initialized instance
needs the equivalent statements run by hand.

## Retroactively revoke PUBLIC CONNECT (already-initialized instance)

`db/init/04-revoke-public-connect.sql` only fires on a fresh volume. On an
existing `pg_data` volume, apply the same revokes directly:

```bash
docker compose exec -T postgres psql -U postgres <<'EOSQL'
REVOKE CONNECT ON DATABASE pump_telemetry FROM PUBLIC;
REVOKE CONNECT ON DATABASE authentik_db FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
EOSQL
```

Safe to run any number of times — `REVOKE` on a privilege that's already
absent is a no-op, not an error. Verify with:

```bash
docker compose exec -T postgres psql -U postgres -c '\l'
```

Each affected database's "Access privileges" column should show an
explicit ACL (no bare `=Tc/<owner>` PUBLIC entry) rather than the blank
default-privileges display.

This does not affect `pdm_app`, `authentik_svc`, or `pdm_corpus_readonly`
connecting to the database each already owns/was granted access to — only
removes the ability to connect to databases they were never granted access
to in the first place.
