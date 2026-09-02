import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dbLoad, dbSql, dbSqlFile, dbUp } from "./compose";

export const CORPUS = {
  file: "berlin-260101.osm.pbf",
  url: "https://download.geofabrik.de/europe/germany/berlin-260101.osm.pbf",
  /** Geofabrik publishes MD5 next to every extract; this is the value for the 2026-01-01 Berlin file. */
  md5: "6d6de8da2d8192c5bbe7dd00e1004c82",
} as const;

const root = join(import.meta.dirname!, "..");
const cacheDir = join(root, "data", "cache");

export async function md5File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}

export async function ensureCorpus(): Promise<string> {
  mkdirSync(cacheDir, { recursive: true });
  const path = join(cacheDir, CORPUS.file);
  if (existsSync(path)) {
    const digest = await md5File(path);
    if (digest === CORPUS.md5) return path;
    console.log(`  cached corpus has md5 ${digest}, expected ${CORPUS.md5}; re-downloading`);
  }
  console.log(`  downloading ${CORPUS.url}`);
  const response = await fetch(CORPUS.url);
  if (!response.ok) throw new Error(`GET ${CORPUS.url} -> ${response.status}`);
  await Bun.write(path, await response.arrayBuffer());
  const digest = await md5File(path);
  if (digest !== CORPUS.md5) throw new Error(`downloaded corpus md5 ${digest} does not match ${CORPUS.md5}`);
  return path;
}

export interface CorpusStats {
  buildings: number;
  roads: number;
  pois: number;
  boundaries: number;
}

async function loadedMd5(): Promise<string | undefined> {
  try {
    const value = await dbSql("SELECT value FROM bench.meta WHERE key = 'corpus_md5'");
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** Database up, corpus imported, bench schema built. Idempotent: a loaded database is left alone. */
export async function ensureDatabase(): Promise<CorpusStats> {
  console.log("database: compose up");
  dbUp();
  const current = await loadedMd5();
  if (current === CORPUS.md5) {
    console.log("database: corpus already loaded");
  } else {
    await ensureCorpus();
    console.log("database: importing corpus (ogr2ogr)");
    dbLoad(CORPUS.file);
    console.log("database: building bench schema");
    await dbSqlFile("/data/schema.sql", { corpus: CORPUS.file, corpus_md5: CORPUS.md5 });
  }
  const rows = await dbSql(
    "SELECT (SELECT count(*) FROM bench.buildings) || '|' || (SELECT count(*) FROM bench.roads) || '|' || (SELECT count(*) FROM bench.pois) || '|' || (SELECT count(*) FROM bench.boundaries)",
  );
  const [buildings, roads, pois, boundaries] = rows.split("|").map(Number);
  const stats = { buildings: buildings ?? 0, roads: roads ?? 0, pois: pois ?? 0, boundaries: boundaries ?? 0 };
  console.log(`database: ${stats.buildings} buildings, ${stats.roads} roads, ${stats.pois} pois, ${stats.boundaries} boundaries`);
  return stats;
}

if (import.meta.main) {
  await ensureDatabase();
}
