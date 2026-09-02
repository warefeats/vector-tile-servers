# Martin vs Tegola vs BBOX vs pg_tileserv vs TiPg vs ldproxy — PostGIS vector tile servers

The runner behind [warefeats.com/benchmarks/postgis-vector-tile-servers/](https://warefeats.com/benchmarks/postgis-vector-tile-servers/). Six open-source servers generate Mapbox Vector Tiles on the fly from the same PostGIS database, and this runner measures single-tile latency, throughput under 10 and 100 concurrent clients, four-tile viewport bursts, time to first tile after a cold start, and resident memory. Part of the [warefeats](https://warefeats.com) benchmark suite.

## Lineage

This is a re-run of the matrix from Fabian Rechsteiner's 2024 master's thesis, [Performancevergleich von Open-Source-Vector-Tiles-Serverlösungen zur Bereitstellung von Geodaten aus PostGIS-Datenbanken](https://unigis.at/files/Mastertheses/Full/107112.pdf) (attachments at [FabianRechsteiner/vector-tiles-benchmark](https://github.com/FabianRechsteiner/vector-tiles-benchmark), MIT). The thesis tested the same six servers with Apache JMeter against Swiss cadastral data on a cloud VM and ranked them Martin, Tegola, BBOX, pg_tileserv, TiPg, ldproxy.

Kept from the thesis: the six servers, PostGIS as the only data source, on-the-fly generation with every server-side tile cache off, the five request shapes (a dense polygon tile, a line tile, a point tile, a low-zoom boundary tile, and four adjacent tiles fetched in parallel), and the three client counts 1, 10 and 100.

Changed: the corpus is a pinned public OpenStreetMap extract instead of a private 1.9 GB cadastral dump, so anyone can rebuild the database byte for byte; every server runs its current release (the thesis ran early-2024 builds); the load generator is [oha](https://github.com/hatoo/oha) instead of JMeter, with the exact request bytes on record; all servers get identical CPU, memory and database-connection budgets; each server's tile for each test coordinate is decoded and its feature count published, so the servers are shown to be doing the same work before their times are compared; and cold start and memory are measured, since the thesis did not. ldproxy appears twice: as shipped, and with the opt-in `PGIS_TILES` extension it gained in 4.4 (2025), which moves tile encoding into PostGIS the way the other five servers already work.

## Servers

| Candidate | Version | Image | Language | MVT encoder | Tile URL used |
|-----------|---------|-------|----------|-------------|---------------|
| Martin | 1.14.0 | `ghcr.io/maplibre/martin:1.14.0` | Rust | PostGIS `ST_AsMVT` | `/{layer}/{z}/{x}/{y}` |
| Tegola | 0.21.2 | `gospatial/tegola:v0.21.2` | Go | PostGIS `ST_AsMVT` (`mvt_postgis` provider) | `/maps/bench/{layer}/{z}/{x}/{y}.pbf` |
| BBOX | 0.6.2 | `vts-bbox:0.6.2`, built from [bbox-services/bbox@v0.6.2](https://github.com/bbox-services/bbox/tree/v0.6.2) by `Dockerfile.bbox` | Rust | PostGIS `ST_AsMVT` | `/xyz/{layer}/{z}/{x}/{y}.mvt` |
| pg_tileserv | 2025-01-31 build | `pramsey/pg_tileserv:20250131` | Go | PostGIS `ST_AsMVT` | `/bench.{layer}/{z}/{x}/{y}.pbf` |
| TiPg | 1.5.0 | `ghcr.io/developmentseed/tipg:1.5.0` | Python | PostGIS `ST_AsMVT` | `/collections/bench.{layer}/tiles/WebMercatorQuad/{z}/{x}/{y}` |
| ldproxy | 4.8.1 | `iide/ldproxy:4.8.1` | Java | ldproxy's own encoder over a feature query | `/bench/collections/{layer}/tiles/WebMercatorQuad/{z}/{y}/{x}` |
| ldproxy (PGIS_TILES) | 4.8.1 | `iide/ldproxy:4.8.1` | Java | PostGIS `ST_AsMVT` via the `PGIS_TILES` extension | same as ldproxy |

BBOX is built from source because the only published image (`sourcepole/bbox-server-qgis`) is amd64-only and would run under emulation on the arm64 rig. The build is the `bbox-tile-server` crate at the `v0.6.2` tag with `--locked`, no map-server or asset-server features, on `rust:1.83.0-bookworm`. pg_tileserv has no image tag for its last release (v1.0.11, 2024-02); the dated `20250131` image is a build of the main branch from that day, and the binary reports its version as `latest`.

Every server connects to the database as the same read-only role (`tiles`) with the same privileges, sees the same four tables, and is asked for the same tile coordinates.

The benchmark page shows each candidate by name and brand colour, not by logo. None of the six projects publishes a trademark policy that licenses its mark for third-party use; the logo files that ship in the Martin and TiPg repositories are covered by those repositories' MIT licence as copyrighted files, which is not a licence to the mark. That is the same line the Redis vs Valkey vs Dragonfly page drew.

## Corpus

The [Geofabrik Berlin extract of 2026-01-01](https://download.geofabrik.de/europe/germany/berlin-260101.osm.pbf), 95,916,520 bytes, MD5 `6d6de8da2d8192c5bbe7dd00e1004c82` (Geofabrik's published checksum), SHA-256 `9a5dff3801473f7d59dc41cad2224c6f590d7d0cb9d8dc0789970902f13c6e94`. The runner downloads it into `data/cache/` and refuses to import a file whose MD5 differs.

Import is GDAL 3.13.3's OSM driver (`ghcr.io/osgeo/gdal:alpine-small-3.13.3`) with the trimmed `data/osmconf.ini`, writing the `points`, `lines` and `multipolygons` layers into schema `osm` reprojected to EPSG:3857, so no server pays for reprojection at request time. `data/schema.sql` then derives four benchmark tables, each with an integer primary key `fid`, a few text properties, and a GIST-indexed `geom` column:

| Table | Source | Geometry | Rows |
|-------|--------|----------|------|
| `bench.buildings` | `multipolygons` where `building` is set | MultiPolygon | 535,572 |
| `bench.roads` | `lines` where `highway` is set | LineString | 451,317 |
| `bench.pois` | `points` with `amenity`, `shop` or `tourism` | Point | 141,188 |
| `bench.boundaries` | `multipolygons` where `boundary = 'administrative'` | MultiPolygon | 122 |

Database: PostgreSQL 18.1 with PostGIS 3.6.1 (`imresamu/postgis:18-3.6`, the multi-arch build of the official image), `shared_buffers=2GB`, `work_mem=64MB`, `effective_cache_size=8GB`, `max_connections=100`, `random_page_cost=1.1`. The whole working set fits in memory; after the warmup passes every server reads from the PostgreSQL buffer cache.

Map data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright).

## Tiles

All coordinates are WebMercatorQuad (XYZ; ldproxy is addressed as z/row/col). The z14 tile is Prenzlauer Berg around Helmholtzplatz, a dense 19th-century block grid.

| Test tile | Layer | z/x/y | What is in it |
|-----------|-------|-------|---------------|
| Buildings z14 (the marquee tile) | `buildings` | 14/8802/5371 | about 2,000 building polygons, 28,000 vertices |
| Roads z14 | `roads` | 14/8802/5371 | about 2,500 highway segments |
| Points z14 | `pois` | 14/8802/5371 | about 2,800 amenity, shop and tourism nodes |
| Boundaries z9 | `boundaries` | 9/275/167 | 55 administrative polygons covering most of Berlin, city outline included |
| Viewport | `buildings` | 15/17604/10742, 15/17605/10742, 15/17604/10743, 15/17605/10743 | the marquee tile's four children, requested in parallel |

## Fairness configuration

Where a concept exists in more than one server it is set to the same value; where it exists in only one, the default is kept and stated.

| Setting | Martin | Tegola | BBOX | pg_tileserv | TiPg | ldproxy |
|---------|--------|--------|------|-------------|------|---------|
| Container | 4 CPUs, 4 GB | same | same | same | same | same, JVM `MaxRAMPercentage=75` |
| Workers | `worker_processes: 4` | `GOMAXPROCS=4` | `worker_threads = 4` | `GOMAXPROCS=4` | `WEB_CONCURRENCY=4` gunicorn workers | JVM sees 4 CPUs |
| DB pool | `pool_size: 8` | `pool_max_conns=8` | 8 (hard-coded in 0.6.2) | `DbPoolMaxConns = 8` | 4 workers × `DB_MAX_CONN_SIZE=2` | `pool.maxConnections: 8` |
| Tile cache | `cache: disable` | none configured | none configured | none | none | `caches: []` |
| Extent | 4096 | 4096 | `tile_size = 4096` | `DefaultResolution = 4096` | `TIPG_TILE_RESOLUTION=4096` | 4096 |
| Buffer | 64 | 64 (in the layer SQL) | `buffer_size = 64` | `DefaultBuffer = 64` | `TIPG_TILE_BUFFER=64` | 128, computed (extent / 256 × 8), not configurable |
| Feature limit | none | none | none | `MaxFeaturesPerTile = -1` | `TIPG_MAX_FEATURES_PER_TILE=1000000` | `featureLimit` 100000 default, never reached |
| Query timeout | none | none | none | `DbTimeout = 60` (default 10 s) | none | none |
| Compression | only if the client asks | gzip whenever an `Accept-Encoding` header is present; recompressed for clients that send none | only if the client asks | only if the client asks | only if the client asks | gzip when the client asks (Dropwizard default) |

The database pool is 8 for everyone because BBOX 0.6.2 hard-codes `max_connections(8)` in its PostGIS datasource. With PostGIS allotted 6 CPUs and one server running at a time, 8 concurrent queries already saturate the database; the 100-connection test therefore measures how well each server queues 100 clients onto 8 database connections, which is the shape of a real deployment. pg_tileserv's default 10-second database timeout would have turned slow tiles into errors that no other server can produce, so it gets the same 60-second budget the load generator uses.

Tiles are requested with `Accept: application/vnd.mapbox-vector-tile` and no `Accept-Encoding` header, as the thesis's JMeter plans did, so the numbers are tile generation, not gzip. One extra single-client pass asks for the marquee tile with `Accept-Encoding: gzip`, as every browser does, and records what each server sends back. Tegola is the exception that the table calls out: it gzips internally and, for a client without `Accept-Encoding`, decompresses the tile again before sending it, so its uncompressed path does strictly more work than its gzip path.

Buffer semantics differ in a way no configuration can align: Martin, BBOX and pg_tileserv select features intersecting the tile plus its buffer, Tegola and TiPg select features intersecting the tile only. The decoded feature counts in the parity table show the difference (58 vs 55 boundary polygons, 2,123 vs 2,019 buildings).

## Methodology

One engine container runs at a time against the shared database. The load generator (`oha` 1.16.0) and the runner (Bun) run on the host and reach the engine through its published port. Per engine, in order:

1. **Cold start.** `docker compose up` from a stopped state, then poll the marquee tile every 50 ms. The sample is the time from Docker's `StartedAt` (process start) to the first `200`, so image pulls and compose overhead are excluded and schema discovery is included. 5 repetitions; the engine stays up after the last. Idle RSS is read from `docker stats` five seconds later.
2. **Parity.** Each test tile is fetched once, decoded, and its byte size, layer names and feature counts recorded, together with the size the server sends when the client accepts gzip.
3. **Single-tile latency.** For each test tile, one connection, 3 warmup passes then 20 measured passes of 5 sequential requests. The sample is the mean latency of a pass. Then the same for the marquee tile with `Accept-Encoding: gzip`.
4. **Viewport burst.** The four z15 children of the marquee tile requested at once over four connections; 3 warmups then 20 repetitions. The sample is the wall time until the last tile lands.
5. **Concurrency.** Closed-loop load on the marquee tile at 10 and then 100 connections: one 10-second warmup pass, then 8 measured passes of 12 seconds. Samples are each pass's successful requests per second and each pass's p99 latency. Requests still in flight when a pass ends are not counted as errors; non-2xx responses, connection errors and 60-second timeouts are.
6. **Memory after load.** `docker stats` RSS right after the 100-connection passes.

The published run file carries every sample. `bun run src/run.ts --smoke` runs a short version of the same protocol (1 cold start, 3 passes of 3 requests, 3 bursts, 10 connections only).

## Results

See `runs/` for the published run files and the [benchmark page](https://warefeats.com/benchmarks/postgis-vector-tile-servers/) for charts and the verdict.

### Run 2026-09-02, M2 Max (local)

Full protocol on the reference rig; the run file is [`runs/2026-09-02-m2-max.json`](runs/2026-09-02-m2-max.json). Verdict and limitations are in [`benchmark.json`](benchmark.json).

| Candidate | Buildings z14, 1 client (mean) | Tiles/s at 10 clients | Tiles/s at 100 clients | p99 at 100 clients | Viewport, 4 tiles (mean) | First tile after start (mean of 5) | RSS idle / after load |
|-----------|-------------------------------:|----------------------:|-----------------------:|-------------------:|-------------------------:|-------------------------------:|----------------------:|
| Martin 1.14.0 | 13.6 ms | 485 | 467 | 234 ms | 5.5 ms | 133 ms | 9 / 40 MB |
| Tegola 0.21.2 | 15.6 ms | 265 | 255 | 1.14 s | 7.5 ms | 142 ms | 8 / 47 MB |
| BBOX 0.6.2 | 15.2 ms | 494 | 395 | 289 ms | 6.6 ms | 147 ms | 11 / 42 MB |
| pg_tileserv 20250131 | 13.7 ms | 221 | 169 (0.15% errors) | 1.14 s | 5.4 ms | 149 ms | 4 / 41 MB |
| TiPg 1.5.0 | 13.8 ms | 332 | 456 | 486 ms | 10.2 ms | 508 ms | 214 / 241 MB |
| ldproxy 4.8.1 | 120.8 ms | 33 | 25 | 4.96 s | 51.7 ms | 3.71 s | 479 / 3,226 MB |
| ldproxy 4.8.1 (PGIS_TILES) | 18.9 ms | 249 | 226 | 1.14 s | 10.5 ms | 3.69 s | 448 / 696 MB |

Roads, points and boundary tiles at one client: Martin 7.2 / 7.7 / 8.9 ms, BBOX 9.6 / 10.2 / 10.3 ms, TiPg 9.2 / 8.8 / 10.4 ms, pg_tileserv 12.9 / 13.9 / 9.2 ms, Tegola 16.5 / 17.4 / 10.8 ms, ldproxy (PGIS_TILES) 15.1 / 16.2 / 9.3 ms, ldproxy 83.6 / 89.4 / 25.4 ms. The gzip-negotiated buildings tile took 14.9 ms on Tegola (its native path) and 15 to 19 ms on the others; stock ldproxy 119 ms.

### Parity

What each server returned for the test tiles, decoded (uncompressed bytes / features). The two groups differ by buffer semantics (see Fairness configuration); stock ldproxy also drops features under half a pixel and simplifies geometry.

| Candidate | Buildings z14 | Roads z14 | Points z14 | Boundaries z9 | Layer name |
|-----------|--------------:|----------:|-----------:|--------------:|------------|
| Martin | 95,511 B / 2,123 | 114,721 B / 2,615 | 140,222 B / 2,985 | 30,546 B / 58 | `buildings` |
| BBOX | 95,351 B / 2,123 | 114,727 B / 2,615 | 140,223 B / 2,985 | 30,546 B / 58 | `buildings` |
| pg_tileserv | 114,657 B / 2,123 | 138,594 B / 2,615 | 167,224 B / 2,982 | 31,000 B / 58 | `bench.buildings` |
| Tegola | 91,826 B / 2,019 | 108,525 B / 2,465 | 133,904 B / 2,838 | 30,275 B / 55 | `buildings` |
| TiPg | 101,774 B / 2,017 | 121,187 B / 2,465 | 148,338 B / 2,836 | 30,536 B / 55 | `buildings` |
| ldproxy (PGIS_TILES) | 91,885 B / 2,017 | 108,737 B / 2,465 | 133,818 B / 2,836 | 31,810 B / 55 | `buildings` |
| ldproxy | 99,164 B / 1,998 | 118,972 B / 2,363 | 160,090 B / 2,836 | 11,456 B / 55 | `buildings` |

With `Accept-Encoding: gzip` every server compressed the buildings tile to 63 to 75 KB.

## Requirements

- [Bun](https://bun.sh) 1.4+
- Docker with Compose v2 (arm64 or amd64), about 6 GB of images plus a 1 GB database volume
- [oha](https://github.com/hatoo/oha) 1.16+ on the host
- `just` (optional, for recipes)
- Internet access on first run (the Berlin extract, 92 MB)

## Running

```bash
bun install

# One-time: build the BBOX image from source (about 10 minutes)
just build-bbox

# Database up, corpus imported (about 5 minutes the first time), then the short protocol on every engine
bun run src/run.ts --smoke

# Full protocol, every engine (about two hours on the reference rig)
bun run src/run.ts

# One or more engines; resume a partial run
bun run src/run.ts --engine=martin,tegola
bun run src/run.ts --resume
```

Results are written to `results.json` (gitignored) after every engine. `--output=<path>` writes elsewhere. `just clean` stops every container this runner starts; `just db-down` also drops the database volume.

## Publishing flow

1. Run the benchmark. The runner writes `results.json`.
2. `bun run src/import.ts --results=results.json` writes a file under `runs/` and appends it to `benchmark.json`.
3. Write the verdict and limitations in `benchmark.json` from the run data, commit and merge the run file with it.
4. In the site repo (`warefeats/warefeats.com`): bump this benchmark's `ref` in `web/data/registry.json` to the merge commit SHA, run `bun run sync`, commit registry + cache, merge, deploy.

Do not pin this repo in the site registry until a run file exists; the site's `sync` fails on an empty `runs` list.

## Tests

```bash
bun run check   # type-check
bun test        # unit tests (tile math, MVT reader, oha parsing, run-file shape)
```

## License

MIT. Map data © OpenStreetMap contributors, ODbL.
