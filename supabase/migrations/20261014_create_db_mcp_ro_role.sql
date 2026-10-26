-- Read-only Postgres role for the "Solviva Databases" MCP connector.
-- Apply to ALL THREE Supabase projects: production, staging and testing.
--
-- Why: one claude.ai connector (monitoring repo, db_mcp.py, Render service
-- solviva-db-mcp) lets the whole Claude Teams org query these databases
-- without a Supabase login each. It connects as db_mcp_ro, which can only
-- SELECT — no INSERT/UPDATE/DELETE/DDL — so the connector cannot write even
-- if asked to. Every public table here has RLS on, hence BYPASSRLS; without
-- it the role would see empty tables.
--
-- The password is set at apply time (replace <PASSWORD>; never commit it) and
-- lives only in the Render service's env (DB_MCP_CALC_URL,
-- DB_MCP_CALC_STAGING_URL, DB_MCP_CALC_TESTING_URL) and the monitoring repo's
-- local .env. Re-running this file rotates the password.
--
-- Rollback: drop owned by db_mcp_ro; drop role db_mcp_ro;

begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'db_mcp_ro') then
    create role db_mcp_ro;
  end if;
end $$;

alter role db_mcp_ro with login password '<PASSWORD>' connection limit 3 bypassrls nocreatedb nocreaterole;
alter role db_mcp_ro set default_transaction_read_only = on;
alter role db_mcp_ro set statement_timeout = '60s';

grant usage on schema public to db_mcp_ro;
grant select on all tables in schema public to db_mcp_ro;
-- Tables created later by migrations (run as postgres) are readable too.
alter default privileges for role postgres in schema public grant select on tables to db_mcp_ro;

commit;
