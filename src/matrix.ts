import { childTiles, type TileCoord } from "./tiles";

export type Engine = "martin" | "tegola" | "bbox" | "pg-tileserv" | "tipg" | "ldproxy" | "ldproxy-pgis";

export const ENGINES: readonly Engine[] = ["martin", "tegola", "bbox", "pg-tileserv", "tipg", "ldproxy", "ldproxy-pgis"];

export interface EngineMeta {
  id: Engine;
  /** Display name, as it appears on the site. */
  name: string;
  version: string;
  image: string;
  homepage: string;
  color: string;
  /** Path of the tile endpoint for `layer` at z/x/y, relative to the engine's root. */
  tilePath: (layer: string, tile: TileCoord) => string;
}

export const ENGINE_META: Record<Engine, EngineMeta> = {
  martin: {
    id: "martin",
    name: "Martin",
    version: "1.14.0",
    image: "ghcr.io/maplibre/martin:1.14.0",
    homepage: "https://martin.maplibre.org",
    color: "#2563EB",
    tilePath: (layer, t) => `/${layer}/${t.z}/${t.x}/${t.y}`,
  },
  tegola: {
    id: "tegola",
    name: "Tegola",
    version: "0.21.2",
    image: "gospatial/tegola:v0.21.2",
    homepage: "https://tegola.io",
    color: "#16A34A",
    tilePath: (layer, t) => `/maps/bench/${layer}/${t.z}/${t.x}/${t.y}.pbf`,
  },
  bbox: {
    id: "bbox",
    name: "BBOX",
    version: "0.6.2",
    image: "vts-bbox:0.6.2 (built from bbox-services/bbox@v0.6.2)",
    homepage: "https://www.bbox.earth",
    color: "#9333EA",
    tilePath: (layer, t) => `/xyz/${layer}/${t.z}/${t.x}/${t.y}.mvt`,
  },
  "pg-tileserv": {
    id: "pg-tileserv",
    name: "pg_tileserv",
    version: "20250131",
    image: "pramsey/pg_tileserv:20250131",
    homepage: "https://github.com/CrunchyData/pg_tileserv",
    color: "#0891B2",
    tilePath: (layer, t) => `/bench.${layer}/${t.z}/${t.x}/${t.y}.pbf`,
  },
  tipg: {
    id: "tipg",
    name: "TiPg",
    version: "1.5.0",
    image: "ghcr.io/developmentseed/tipg:1.5.0",
    homepage: "https://developmentseed.org/tipg/",
    color: "#EA580C",
    tilePath: (layer, t) => `/collections/bench.${layer}/tiles/WebMercatorQuad/${t.z}/${t.x}/${t.y}`,
  },
  ldproxy: {
    id: "ldproxy",
    name: "ldproxy",
    version: "4.8.1",
    image: "iide/ldproxy:4.8.1",
    homepage: "https://www.ldproxy.net",
    color: "#DC2626",
    // OGC API Tiles addresses tiles as tileMatrix/tileRow/tileCol, i.e. z/y/x. ldproxy 4 serves each
    // API at its own root (the /rest/services prefix of ldproxy 3 is gone) and picks the tile format
    // from the Accept header, which every request in this runner sends.
    tilePath: (layer, t) => `/bench/collections/${layer}/tiles/WebMercatorQuad/${t.z}/${t.y}/${t.x}`,
  },
  "ldproxy-pgis": {
    id: "ldproxy-pgis",
    name: "ldproxy (PGIS_TILES)",
    version: "4.8.1",
    image: "iide/ldproxy:4.8.1",
    homepage: "https://www.ldproxy.net",
    color: "#A16207",
    tilePath: (layer, t) => `/bench/collections/${layer}/tiles/WebMercatorQuad/${t.z}/${t.y}/${t.x}`,
  },
};

/**
 * Sent with every tile request, to every server. The OGC API servers (ldproxy, TiPg) negotiate the
 * tile format from Accept; the XYZ servers ignore it. No Accept-Encoding: tiles are requested
 * uncompressed except in the explicit gzip variant.
 */
export const TILE_REQUEST_HEADERS: Readonly<Record<string, string>> = { Accept: "application/vnd.mapbox-vector-tile" };

export type Layer = "buildings" | "roads" | "pois" | "boundaries";

export type TileId = "buildings-z14" | "roads-z14" | "pois-z14" | "boundaries-z9";

export interface TileSpec {
  id: TileId;
  layer: Layer;
  tile: TileCoord;
  title: string;
  /** What the tile stands for, for the run file and README. */
  description: string;
}

/**
 * Prenzlauer Berg, Berlin (Helmholtzplatz / Kollwitzplatz): a dense 19th-century block grid with
 * about 2,000 buildings, 2,500 road segments and 2,800 POIs in one z14 tile.
 */
const MARQUEE_Z14: TileCoord = { z: 14, x: 8802, y: 5371 };

export const TILES: readonly TileSpec[] = [
  {
    id: "buildings-z14",
    layer: "buildings",
    tile: MARQUEE_Z14,
    title: "Buildings z14",
    description: "Dense polygon tile: every building footprint in a 1.5 km Prenzlauer Berg tile (about 2,000 polygons).",
  },
  {
    id: "roads-z14",
    layer: "roads",
    tile: MARQUEE_Z14,
    title: "Roads z14",
    description: "Line tile: every highway=* way in the same Prenzlauer Berg tile (about 2,500 lines).",
  },
  {
    id: "pois-z14",
    layer: "pois",
    tile: MARQUEE_Z14,
    title: "Points z14",
    description: "Point tile: amenity, shop and tourism nodes in the same Prenzlauer Berg tile (about 2,800 points).",
  },
  {
    id: "boundaries-z9",
    layer: "boundaries",
    tile: { z: 9, x: 275, y: 167 },
    title: "Boundaries z9",
    description: "Low-zoom polygon tile: the 55 administrative boundary polygons covering most of Berlin, city outline included.",
  },
];

/** The thesis's test 2: four adjacent tiles fetched in parallel, one zoom in from the marquee tile. */
export const VIEWPORT: { layer: Layer; tiles: TileCoord[] } = {
  layer: "buildings",
  tiles: childTiles(MARQUEE_Z14),
};

export const CONCURRENCY_LEVELS = [10, 100] as const;
export type ConcurrencyLevel = (typeof CONCURRENCY_LEVELS)[number];

export interface Protocol {
  coldStart: { reps: number };
  single: { warmupPasses: number; passes: number; requestsPerPass: number };
  burst: { warmups: number; reps: number };
  concurrency: { levels: readonly ConcurrencyLevel[]; warmupSeconds: number; passes: number; passSeconds: number };
  requestTimeoutSeconds: number;
}

export function protocol(smoke: boolean): Protocol {
  if (smoke) {
    return {
      coldStart: { reps: 1 },
      single: { warmupPasses: 1, passes: 3, requestsPerPass: 3 },
      burst: { warmups: 1, reps: 3 },
      concurrency: { levels: [10], warmupSeconds: 3, passes: 2, passSeconds: 4 },
      requestTimeoutSeconds: 60,
    };
  }
  return {
    coldStart: { reps: 5 },
    single: { warmupPasses: 3, passes: 20, requestsPerPass: 5 },
    burst: { warmups: 3, reps: 20 },
    concurrency: { levels: CONCURRENCY_LEVELS, warmupSeconds: 10, passes: 8, passSeconds: 12 },
    requestTimeoutSeconds: 60,
  };
}

const ENGINE_HOST = process.env.ENGINE_HOST ?? "127.0.0.1";
const ENGINE_PORT = process.env.ENGINE_PORT ?? "8099";

export function engineBaseUrl(): string {
  return `http://${ENGINE_HOST}:${ENGINE_PORT}`;
}

export function tileUrl(engine: Engine, layer: Layer, tile: TileCoord): string {
  return engineBaseUrl() + ENGINE_META[engine].tilePath(layer, tile);
}

export function composeProject(engine: Engine): string {
  return `vts-${engine}`;
}

export function containerName(engine: Engine): string {
  return `${composeProject(engine)}-engine-1`;
}

export function composeFile(engine: Engine): string {
  return `docker-compose.${engine}.yml`;
}
