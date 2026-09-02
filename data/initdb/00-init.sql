-- Runs once, on first database initialisation (before the image's own PostGIS init script).
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA IF NOT EXISTS osm;
CREATE SCHEMA IF NOT EXISTS bench;
-- Every tile server connects as this read-only role with identical privileges.
CREATE ROLE tiles LOGIN PASSWORD 'tiles';
GRANT USAGE ON SCHEMA bench TO tiles;
ALTER DEFAULT PRIVILEGES IN SCHEMA bench GRANT SELECT ON TABLES TO tiles;
