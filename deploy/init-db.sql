-- Run once as a Postgres superuser to create a dedicated, least-privilege
-- role and database for NoteGraph:
--   psql -h <host> -U postgres -v pw="'<strong password>'" -f init-db.sql
CREATE ROLE notegraph LOGIN PASSWORD :pw;
CREATE DATABASE notegraph OWNER notegraph;
REVOKE ALL ON DATABASE notegraph FROM PUBLIC;
\connect notegraph
ALTER SCHEMA public OWNER TO notegraph;
