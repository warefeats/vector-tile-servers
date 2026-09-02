import { engineDown, enginePrepare, containerRssMb } from "./compose";
import { type CorpusStats, ensureDatabase } from "./db";
import {
  type BurstResult,
  type ColdStartResult,
  type ConcurrencyResult,
  type ParityResult,
  type SingleTileResult,
  runBurst,
  runColdStart,
  runConcurrency,
  runParity,
  runSingleTile,
} from "./load-runner";
import { ENGINE_META, ENGINES, type Engine, TILES, VIEWPORT, protocol } from "./matrix";

export interface EngineResult {
  engine: Engine;
  image: string;
  startedAt: string;
  durationS: number;
  coldStart: ColdStartResult;
  parity: Record<string, ParityResult>;
  single: Record<string, SingleTileResult>;
  burst: BurstResult;
  concurrency: Record<string, ConcurrencyResult>;
  rssAfterLoadMb: number;
}

export interface RawResults {
  schemaVersion: 1;
  generatedAt: string;
  smoke: boolean;
  corpus: CorpusStats | null;
  tiles: { id: string; layer: string; z: number; x: number; y: number }[];
  viewport: { layer: string; tiles: { z: number; x: number; y: number }[] };
  results: EngineResult[];
  failures: { engine: Engine; error: string }[];
}

const args = process.argv.slice(2);
const smoke = args.includes("--smoke");
const resume = args.includes("--resume");
const engineFilter = args.find((a) => a.startsWith("--engine="))?.split("=")[1];
const outputPath = args.find((a) => a.startsWith("--output="))?.split("=")[1] ?? new URL("../results.json", import.meta.url).pathname;

const engines = ENGINES.filter((engine) => !engineFilter || engineFilter.split(",").includes(engine));
if (engines.length === 0) {
  console.error(`no engine matches --engine=${engineFilter}; known: ${ENGINES.join(", ")}`);
  process.exit(1);
}

const plan = protocol(smoke);
const marquee = TILES[0]!;

async function loadExisting(): Promise<RawResults | undefined> {
  try {
    return (await Bun.file(outputPath).json()) as RawResults;
  } catch {
    return undefined;
  }
}

const existing = resume ? await loadExisting() : undefined;
const results: EngineResult[] = existing?.results ?? [];
const failures: { engine: Engine; error: string }[] = (existing?.failures ?? []).filter((f) => !engines.includes(f.engine));

async function save(corpus: CorpusStats | null): Promise<void> {
  const out: RawResults = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    smoke,
    corpus,
    tiles: TILES.map((t) => ({ id: t.id, layer: t.layer, ...t.tile })),
    viewport: { layer: VIEWPORT.layer, tiles: VIEWPORT.tiles },
    results,
    failures,
  };
  await Bun.write(outputPath, JSON.stringify(out, null, 2) + "\n");
}

console.log(`vector-tile-servers: ${smoke ? "SMOKE" : "FULL"} protocol, ${engines.length} engine(s): ${engines.join(", ")}${resume ? " (resume)" : ""}`);
console.log(`  marquee tile: ${marquee.layer} ${marquee.tile.z}/${marquee.tile.x}/${marquee.tile.y}; concurrency levels ${plan.concurrency.levels.join(", ")}`);

const corpus = await ensureDatabase();

for (const engine of engines) {
  if (resume && results.some((r) => r.engine === engine)) {
    console.log(`\n> ${engine}: already measured, skipping`);
    continue;
  }
  const started = Date.now();
  console.log(`\n> ${engine} (${ENGINE_META[engine].image})`);
  try {
    enginePrepare(engine);
    console.log("  cold start");
    const coldStart = await runColdStart(engine, marquee, plan);
    console.log("  parity");
    const parity = await runParity(engine, TILES);
    console.log("  single-tile latency (1 connection)");
    const single: Record<string, SingleTileResult> = {};
    for (const spec of TILES) single[spec.id] = runSingleTile(engine, spec, plan);
    single[`${marquee.id}-gzip`] = runSingleTile(engine, marquee, plan, { "Accept-Encoding": "gzip" });
    console.log("  viewport burst");
    const burst = await runBurst(engine, plan);
    console.log("  concurrency");
    const concurrency: Record<string, ConcurrencyResult> = {};
    for (const level of plan.concurrency.levels) concurrency[String(level)] = runConcurrency(engine, marquee, level, plan);
    const rssAfterLoadMb = await containerRssMb(engine);
    console.log(`    RSS after load: ${rssAfterLoadMb.toFixed(1)} MiB`);
    results.push({
      engine,
      image: ENGINE_META[engine].image,
      startedAt: new Date(started).toISOString(),
      durationS: Math.round((Date.now() - started) / 1000),
      coldStart,
      parity,
      single,
      burst,
      concurrency,
      rssAfterLoadMb,
    });
    const index = failures.findIndex((f) => f.engine === engine);
    if (index >= 0) failures.splice(index, 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  FAILED ${engine}: ${message}`);
    failures.push({ engine, error: message });
  } finally {
    engineDown(engine);
    await save(corpus);
    console.log(`  [saved ${results.length} results, ${failures.length} failures to ${outputPath}]`);
  }
}

console.log(`\nDone: ${results.length} engines measured, ${failures.length} failed. Results in ${outputPath}`);
if (failures.length > 0) process.exit(1);
