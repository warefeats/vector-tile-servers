#!/bin/sh
# Runs inside the GDAL container: OSM PBF -> PostGIS (schema osm), reprojected to EPSG:3857.
set -eu
CORPUS="${CORPUS:-berlin-260101.osm.pbf}"
SRC="/data/cache/${CORPUS}"
if [ ! -f "$SRC" ]; then
  echo "corpus not found: $SRC" >&2
  exit 1
fi
echo "importing ${CORPUS} into schema osm (EPSG:3857)"
ogr2ogr -f PostgreSQL \
  "PG:host=${PGHOST} dbname=${PGDATABASE} user=${PGUSER} password=${PGPASSWORD}" \
  "$SRC" points lines multipolygons \
  -oo CONFIG_FILE=/data/osmconf.ini \
  -lco SCHEMA=osm -lco GEOMETRY_NAME=geom -lco FID=fid -lco SPATIAL_INDEX=GIST -lco OVERWRITE=YES \
  -t_srs EPSG:3857 \
  --config OGR_INTERLEAVED_READING YES \
  --config PG_USE_COPY YES \
  --config OSM_MAX_TMPFILE_SIZE 4000 \
  -progress
echo "import done"
