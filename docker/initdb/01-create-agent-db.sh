#!/usr/bin/env bash
# Runs once, on first Postgres initialisation.
# Temporal's auto-setup creates the `temporal` and `temporal_visibility`
# databases itself; this script only creates the separate app database.
set -euo pipefail

: "${AGENT_DB_NAME:=agent}"
: "${AGENT_DB_USER:=agent}"
: "${AGENT_DB_PASSWORD:=agent}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v agent_db="$AGENT_DB_NAME" \
  -v agent_user="$AGENT_DB_USER" \
  -v agent_password="$AGENT_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'agent_user', :'agent_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'agent_user')
\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'agent_db', :'agent_user')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'agent_db')
\gexec
SQL

echo "created app database '$AGENT_DB_NAME' owned by '$AGENT_DB_USER'"
