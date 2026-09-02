-- Benchmark layers, derived from the raw ogr2ogr import. Run as postgres after import.sh.
-- Every table: integer primary key `fid`, a handful of string properties, one 3857 geometry
-- column `geom` with a GIST index. This is the shape all six servers auto-discover.
DROP TABLE IF EXISTS bench.buildings, bench.roads, bench.pois, bench.boundaries, bench.meta;

CREATE TABLE bench.buildings AS
  SELECT fid, osm_id, name, building, geom
  FROM osm.multipolygons
  WHERE building IS NOT NULL;

CREATE TABLE bench.roads AS
  SELECT fid, osm_id, name, highway, geom
  FROM osm.lines
  WHERE highway IS NOT NULL;

CREATE TABLE bench.pois AS
  SELECT fid, osm_id, name, amenity, shop, tourism, geom
  FROM osm.points
  WHERE amenity IS NOT NULL OR shop IS NOT NULL OR tourism IS NOT NULL;

CREATE TABLE bench.boundaries AS
  SELECT fid, osm_id, name, admin_level, geom
  FROM osm.multipolygons
  WHERE boundary = 'administrative' AND admin_level IS NOT NULL;

ALTER TABLE bench.buildings ADD PRIMARY KEY (fid);
ALTER TABLE bench.roads ADD PRIMARY KEY (fid);
ALTER TABLE bench.pois ADD PRIMARY KEY (fid);
ALTER TABLE bench.boundaries ADD PRIMARY KEY (fid);

CREATE INDEX buildings_geom_idx ON bench.buildings USING GIST (geom);
CREATE INDEX roads_geom_idx ON bench.roads USING GIST (geom);
CREATE INDEX pois_geom_idx ON bench.pois USING GIST (geom);
CREATE INDEX boundaries_geom_idx ON bench.boundaries USING GIST (geom);

CREATE TABLE bench.meta (key text PRIMARY KEY, value text NOT NULL);
INSERT INTO bench.meta VALUES
  ('corpus', :'corpus'),
  ('corpus_md5', :'corpus_md5'),
  ('schema_version', '1'),
  ('loaded_at', now()::text);

GRANT SELECT ON ALL TABLES IN SCHEMA bench TO tiles;

VACUUM ANALYZE bench.buildings;
VACUUM ANALYZE bench.roads;
VACUUM ANALYZE bench.pois;
VACUUM ANALYZE bench.boundaries;
