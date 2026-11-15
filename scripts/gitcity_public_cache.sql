-- Dedicated GitCity public snapshot cache ONLY. Execute on a NEW GitCity
-- PostgreSQL database with a least-privilege app role; never on other projects.
-- This stores published GitHub repository graphs, not user data or tokens.
CREATE TABLE IF NOT EXISTS gitcity_public_city_snapshots (
  repo_key text PRIMARY KEY,
  graph_json text NOT NULL,
  cached_at bigint NOT NULL,
  CONSTRAINT gitcity_public_city_graph_size
    CHECK (octet_length(graph_json) <= 500000)
);
CREATE INDEX IF NOT EXISTS gitcity_public_city_cached_at
  ON gitcity_public_city_snapshots(cached_at DESC);
