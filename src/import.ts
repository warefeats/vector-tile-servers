import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ENGINE_META, type Engine, TILES, type TileSpec, protocol as protocolFor } from "./matrix";
import type { EngineResult, RawResults } from "./run";
import { type Statistics, mean, percentile, round, statistics } from "./stats";

export interface RunMetadata {
  id: string;
  label: string;
  publishedAt: string;
  environment: { machine: string; chip: string; cores: string; memory: string; os: string; arch: string; runtime: string };
  protocol: { warmups: number; runs: number; processModel: string; cacheState: string; output: string };
}

export type Metric = { value: number; unit: string; label?: string };

export interface Candidate {
  id: string;
  name: string;
  version: string;
  color?: string;
  homepage?: string;
  statistics: Statistics;
  samplesMs: number[];
  metrics?: Record<string, Metric>;
}

/** How a test's `value` summarizes each candidate's samples. "other": a value the site cannot recompute from the per-pass numbers (a median pooled over every request of every pass, a percentile of the per-pass numbers, a ratio); the test's description says what it is. */
export type TestStatistic = "mean" | "median" | "min" | "max" | "other";

export interface TestResult {
  candidateId: string;
  value: number;
  /** One measurement per measured pass, in the test's unit and in pass order: exactly the array `value` was computed from. */
  samples?: number[];
}

export interface BenchmarkTest {
  id: string;
  title: string;
  description: string;
  unit: string;
  lowerIsBetter: boolean;
  results: TestResult[];
  statistic?: TestStatistic;
}

export interface BenchmarkSection {
  id: string;
  title: string;
  deck: string;
  unit: string;
  lowerIsBetter: boolean;
  verdict: { winnerId: string; headline: string; summary: string };
  candidates: Candidate[];
  tests: BenchmarkTest[];
}

export interface RunFile {
  schemaVersion: 1;
  id: string;
  label: string;
  publishedAt: string;
  environment: RunMetadata["environment"];
  protocol: RunMetadata["protocol"];
  candidates: [];
  sections: BenchmarkSection[];
}

export function validateResults(raw: unknown): RawResults {
  if (!raw || typeof raw !== "object") throw new Error("results: not an object");
  const r = raw as Partial<RawResults>;
  if (r.schemaVersion !== 1) throw new Error("results: unsupported schemaVersion");
  if (!Array.isArray(r.results) || r.results.length === 0) throw new Error("results: no engine results");
  return raw as RawResults;
}

function candidate(result: EngineResult, samples: number[], metrics: Record<string, Metric>): Candidate {
  const meta = ENGINE_META[result.engine];
  return {
    id: meta.id,
    name: meta.name,
    version: meta.version,
    color: meta.color,
    homepage: meta.homepage,
    statistics: statistics(samples),
    samplesMs: samples,
    metrics,
  };
}

/** One candidate's row of a test: its value and, when the value summarizes per-pass measurements, the array it was computed from. */
function row(candidateId: string, value: number, samples?: number[]): TestResult {
  return samples ? { candidateId, value, samples } : { candidateId, value };
}

/** The per-pass values of the passes that completed a request, the array a per-pass median is over; nothing when no pass completed one. */
function measured(samples: (number | null)[]): number[] | undefined {
  const completed = samples.filter((sample): sample is number => sample !== null);
  return completed.length > 0 ? completed : undefined;
}

function ratio(a: number, b: number): string {
  return `${(a / b).toFixed(1)}x`;
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(ms < 100 ? 1 : 0)} ms`;
}

function marqueeOf(raw: RawResults): TileSpec {
  const first = raw.tiles[0];
  return TILES.find((t) => t.id === first?.id) ?? TILES[0]!;
}

export function buildSingleTileSection(raw: RawResults): BenchmarkSection {
  const marquee = marqueeOf(raw);
  const candidates = raw.results.map((result) => {
    const metrics: Record<string, Metric> = {};
    for (const spec of TILES) {
      const single = result.single[spec.id];
      const parity = result.parity[spec.id];
      if (single) {
        metrics[`${spec.id}-mean`] = { value: single.meanMs, unit: "ms", label: `${spec.title} mean latency` };
        metrics[`${spec.id}-p99`] = { value: single.p99Ms, unit: "ms", label: `${spec.title} p99 latency` };
      }
      if (parity) {
        metrics[`${spec.id}-bytes`] = { value: parity.bytes, unit: "B", label: `${spec.title} tile size` };
        metrics[`${spec.id}-features`] = { value: parity.features, unit: "features", label: `${spec.title} features in tile` };
      }
    }
    const gzipKey = `${marquee.id}-gzip`;
    const gzipSingle = result.single[gzipKey];
    const gzipParity = result.parity[marquee.id]?.gzip;
    if (gzipSingle) metrics[`${gzipKey}-mean`] = { value: gzipSingle.meanMs, unit: "ms", label: `${marquee.title} mean latency, gzip negotiated` };
    if (gzipParity) metrics[`${gzipKey}-bytes`] = { value: gzipParity.bytes, unit: "B", label: `${marquee.title} transferred bytes, gzip negotiated${gzipParity.contentEncoding ? "" : " (server sent it uncompressed)"}` };
    return candidate(result, result.single[marquee.id]?.samplesMs ?? [], metrics);
  });
  const tests: BenchmarkTest[] = TILES.filter((spec) => raw.results.every((r) => r.single[spec.id])).map((spec) => ({
    id: `mean-${spec.id}`,
    title: spec.title,
    description: `Mean latency over one connection. ${spec.description}`,
    unit: "ms",
    lowerIsBetter: true,
    results: raw.results.map((r) => {
      const single = r.single[spec.id]!;
      return row(r.engine, single.meanMs, single.samplesMs);
    }),
    statistic: "mean",
  }));
  const gzipKey = `${marquee.id}-gzip`;
  if (raw.results.every((r) => r.single[gzipKey])) {
    tests.push({
      id: `mean-${gzipKey}`,
      title: `${marquee.title}, gzip`,
      description: `Mean latency over one connection when the client accepts gzip, as browsers do: the ${marquee.title.toLowerCase()} tile including whatever compression the server applies.`,
      unit: "ms",
      lowerIsBetter: true,
      results: raw.results.map((r) => {
        const single = r.single[gzipKey]!;
        return row(r.engine, single.meanMs, single.samplesMs);
      }),
      statistic: "mean",
    });
  }
  const ranked = [...candidates].sort((a, b) => a.statistics.meanMs - b.statistics.meanMs);
  const best = ranked[0]!;
  const worst = ranked[ranked.length - 1]!;
  return {
    id: "single-tile-latency",
    title: "Single-tile latency",
    deck: "One client, one tile at a time: mean response time for a dense building tile, a road tile, a point tile and a low-zoom boundary tile, each generated from PostGIS on every request.",
    unit: "ms",
    lowerIsBetter: true,
    verdict: {
      winnerId: best.id,
      headline: `${best.name} returned the ${marquee.title.toLowerCase()} tile in ${fmtMs(best.statistics.meanMs)} on average; ${worst.name} took ${fmtMs(worst.statistics.meanMs)} (${ratio(worst.statistics.meanMs, best.statistics.meanMs)})`,
      summary: `Sequential requests over a single keep-alive connection, ${raw.smoke ? "smoke" : "full"} protocol; per-pass means are the samples.`,
    },
    candidates,
    tests,
  };
}

export function buildConcurrencySection(raw: RawResults): BenchmarkSection {
  const marquee = marqueeOf(raw);
  const levels = Object.keys(raw.results[0]!.concurrency)
    .map(Number)
    .sort((a, b) => a - b)
    .filter((level) => raw.results.every((r) => r.concurrency[String(level)]));
  const top = levels[levels.length - 1]!;
  const passMs = protocolFor(raw.smoke).concurrency.passSeconds * 1000;
  const candidates = raw.results.map((result) => {
    const metrics: Record<string, Metric> = {};
    for (const level of levels) {
      const c = result.concurrency[String(level)]!;
      metrics[`c${level}-rps`] = { value: c.rps, unit: "req/s", label: `Throughput at ${level} connections` };
      if (c.p50Ms !== null) metrics[`c${level}-p50`] = { value: c.p50Ms, unit: "ms", label: `p50 latency at ${level} connections` };
      if (c.p99Ms !== null) metrics[`c${level}-p99`] = { value: c.p99Ms, unit: "ms", label: `p99 latency at ${level} connections` };
      metrics[`c${level}-errors`] = { value: round(c.errorRate * 100, 2), unit: "%", label: `Failed requests at ${level} connections` };
      metrics[`c${level}-min-completed`] = { value: c.minCompletedPerPass, unit: "requests", label: `Fewest requests completed in one pass at ${level} connections` };
    }
    metrics["rss-after-load"] = { value: round(result.rssAfterLoadMb, 1), unit: "MB", label: "RSS after the load passes" };
    return candidate(result, result.concurrency[String(top)]!.samplesRps, metrics);
  });
  const tests: BenchmarkTest[] = [];
  for (const level of levels) {
    tests.push({
      id: `rps-c${level}`,
      title: `Throughput, ${level} connections`,
      description: `Successful ${marquee.title.toLowerCase()} tiles per second with ${level} closed-loop clients.`,
      unit: "req/s",
      lowerIsBetter: false,
      results: raw.results.map((r) => {
        const c = r.concurrency[String(level)]!;
        return row(r.engine, c.rps, c.samplesRps);
      }),
      statistic: "mean",
    });
  }
  for (const level of levels) {
    tests.push({
      id: `p99-c${level}`,
      title: `p99 latency, ${level} connections`,
      description: `Median across passes of each pass's p99 response time at ${level} connections. A pass in which a server completed no request is left out of its median; a server that completed no request in any pass is charged the whole ${passMs / 1000} s pass.`,
      unit: "ms",
      lowerIsBetter: true,
      results: raw.results.map((r) => {
        const c = r.concurrency[String(level)]!;
        return row(r.engine, c.p99Ms ?? passMs, measured(c.samplesP99Ms));
      }),
      statistic: "median",
    });
  }
  tests.push({
    id: `errors-c${top}`,
    title: `Failed requests, ${top} connections`,
    description: `Non-2xx responses plus connection errors and 60 s timeouts as a share of all requests at ${top} connections.`,
    unit: "%",
    lowerIsBetter: true,
    results: raw.results.map((r) => row(r.engine, round(r.concurrency[String(top)]!.errorRate * 100, 2))),
    statistic: "other",
  });
  const ranked = [...candidates].sort((a, b) => b.statistics.meanMs - a.statistics.meanMs);
  const best = ranked[0]!;
  const worst = ranked[ranked.length - 1]!;
  return {
    id: "concurrency",
    title: "Throughput under concurrency",
    deck: `Closed-loop load on the ${marquee.title.toLowerCase()} tile at ${levels.join(" and ")} concurrent connections; every request regenerates the tile from PostGIS through an 8-connection pool.`,
    unit: "req/s",
    lowerIsBetter: false,
    verdict: {
      winnerId: best.id,
      headline: `${best.name} sustained ${best.statistics.meanMs.toFixed(0)} tiles/s at ${top} connections; ${worst.name} managed ${worst.statistics.meanMs.toFixed(worst.statistics.meanMs < 10 ? 1 : 0)}`,
      summary: `Per-pass successful requests per second at ${top} connections are the samples.`,
    },
    candidates,
    tests,
  };
}

export function buildBurstSection(raw: RawResults): BenchmarkSection {
  const candidates = raw.results.map((result) =>
    candidate(result, result.burst.samplesMs, {
      "burst-mean": { value: result.burst.meanMs, unit: "ms", label: "Mean time to all four tiles" },
      "burst-max": { value: result.burst.maxMs, unit: "ms", label: "Slowest viewport" },
      "slowest-tile-mean": { value: result.burst.slowestTileMeanMs, unit: "ms", label: "Mean of the slowest tile per viewport" },
      "burst-errors": { value: round(result.burst.errorRate * 100, 2), unit: "%", label: "Failed tile requests" },
    }),
  );
  const tests: BenchmarkTest[] = [
    {
      id: "burst-mean",
      title: "Viewport, mean",
      description: "Mean wall time until all four z15 building tiles have arrived, requested in parallel.",
      unit: "ms",
      lowerIsBetter: true,
      results: raw.results.map((r) => row(r.engine, r.burst.meanMs, r.burst.samplesMs)),
      statistic: "mean",
    },
    {
      id: "burst-max",
      title: "Viewport, slowest",
      description: "The slowest of the measured viewport loads.",
      unit: "ms",
      lowerIsBetter: true,
      results: raw.results.map((r) => row(r.engine, r.burst.maxMs, r.burst.samplesMs)),
      statistic: "max",
    },
  ];
  const ranked = [...candidates].sort((a, b) => a.statistics.meanMs - b.statistics.meanMs);
  const best = ranked[0]!;
  const worst = ranked[ranked.length - 1]!;
  return {
    id: "viewport-burst",
    title: "Viewport burst",
    deck: "Four adjacent z15 building tiles requested at once, the way a map view loads; wall time until the last one lands.",
    unit: "ms",
    lowerIsBetter: true,
    verdict: {
      winnerId: best.id,
      headline: `${best.name} filled the four-tile viewport in ${fmtMs(best.statistics.meanMs)}; ${worst.name} needed ${fmtMs(worst.statistics.meanMs)}`,
      summary: "Wall time per viewport load is the sample.",
    },
    candidates,
    tests,
  };
}

export function buildColdStartSection(raw: RawResults): BenchmarkSection {
  const candidates = raw.results.map((result) =>
    candidate(result, result.coldStart.samplesMs, {
      "first-tile-mean": { value: round(mean(result.coldStart.samplesMs), 0), unit: "ms", label: "Mean time to first tile" },
      "first-tile-median": { value: round(percentile(result.coldStart.samplesMs, 0.5), 0), unit: "ms", label: "Median time to first tile" },
      "idle-rss": { value: round(result.coldStart.idleRssMb, 1), unit: "MB", label: "Idle RSS after start" },
      "rss-after-load": { value: round(result.rssAfterLoadMb, 1), unit: "MB", label: "RSS after the load passes" },
    }),
  );
  const tests: BenchmarkTest[] = [
    {
      id: "first-tile",
      title: "Time to first tile",
      description: "Mean time from container process start until the building tile is served, including schema discovery, over five starts.",
      unit: "ms",
      lowerIsBetter: true,
      results: raw.results.map((r) => row(r.engine, round(mean(r.coldStart.samplesMs), 0), r.coldStart.samplesMs)),
      statistic: "mean",
    },
    {
      id: "idle-rss",
      title: "Idle memory",
      description: "Container RSS five seconds after the first tile, before any load.",
      unit: "MB",
      lowerIsBetter: true,
      results: raw.results.map((r) => {
        const value = round(r.coldStart.idleRssMb, 1);
        return row(r.engine, value, [value]);
      }),
      statistic: "mean",
    },
    {
      id: "loaded-rss",
      title: "Memory after load",
      description: "Container RSS right after the concurrency passes.",
      unit: "MB",
      lowerIsBetter: true,
      results: raw.results.map((r) => {
        const value = round(r.rssAfterLoadMb, 1);
        return row(r.engine, value, [value]);
      }),
      statistic: "mean",
    },
  ];
  const ranked = [...candidates].sort((a, b) => a.statistics.meanMs - b.statistics.meanMs);
  const best = ranked[0]!;
  const worst = ranked[ranked.length - 1]!;
  return {
    id: "cold-start",
    title: "Cold start and footprint",
    deck: "Time from process start to the first served tile, and resident memory idle and after load.",
    unit: "ms",
    lowerIsBetter: true,
    verdict: {
      winnerId: best.id,
      headline: `${best.name} served its first tile ${fmtMs(best.statistics.meanMs)} after process start on average; ${worst.name} took ${fmtMs(worst.statistics.meanMs)}`,
      summary: "Each sample is one container start measured from Docker's StartedAt to the first 200 response; five starts per server.",
    },
    candidates,
    tests,
  };
}

/** Every section of a run, in page order. */
export function buildSections(raw: RawResults): BenchmarkSection[] {
  return [buildSingleTileSection(raw), buildConcurrencySection(raw), buildBurstSection(raw), buildColdStartSection(raw)];
}

export function buildRun(raw: RawResults, meta: RunMetadata): RunFile {
  const results = validateResults(raw);
  return {
    schemaVersion: 1,
    id: meta.id,
    label: meta.label,
    publishedAt: meta.publishedAt,
    environment: meta.environment,
    protocol: meta.protocol,
    candidates: [],
    sections: buildSections(results),
  };
}

export function rigSlug(chip: string): string {
  return chip
    .toLowerCase()
    .replace(/^apple\s+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Engines in the order the site lists them, so ordering is stable across runs. */
export function orderResults(raw: RawResults): RawResults {
  const order: Engine[] = Object.keys(ENGINE_META) as Engine[];
  return { ...raw, results: [...raw.results].sort((a, b) => order.indexOf(a.engine) - order.indexOf(b.engine)) };
}

if (import.meta.main) {
  const root = join(import.meta.dirname!, "..");
  const resultsArg = process.argv.find((a) => a.startsWith("--results="))?.split("=")[1];
  const resultsPath = resultsArg ? resolve(resultsArg) : join(root, "results.json");
  const raw = orderResults(validateResults(await Bun.file(resultsPath).json()));
  if (raw.smoke) console.warn("warning: importing a SMOKE run");
  const publishedAt = raw.generatedAt.split("T")[0]!;
  const chip = "Apple M2 Max";
  const meta: RunMetadata = {
    id: `${publishedAt}-${rigSlug(chip)}`,
    label: "M2 Max (local)",
    publishedAt,
    environment: {
      machine: "MacBook Pro",
      chip,
      cores: "12 CPU cores (8 performance, 4 efficiency)",
      memory: "96 GB",
      os: "macOS 26.6.2",
      arch: "arm64",
      runtime: "Docker 29.4.0 (OrbStack); PostGIS 18 / 3.6.1 in its own container (6 CPUs, 12 GB); one tile server container at a time (4 CPUs, 4 GB); oha 1.16.0 on the host",
    },
    protocol: {
      warmups: 3,
      runs: 20,
      processModel: "One server container at a time against a shared PostGIS container; 8 database connections per server; 4 workers where the concept exists; 5 cold starts, 20 single-tile passes of 5 requests per tile, 20 four-tile viewport bursts, 8 passes of 12 s at 10 and at 100 connections",
      cacheState: "No server-side tile cache anywhere; PostgreSQL buffer cache warm after warmups; tiles requested without compression",
      output: "oha 1.16.0 JSON (latency percentiles, request counts, status codes); Bun fetch for cold start, parity and viewport bursts; docker stats for RSS",
    },
  };
  const run = buildRun(raw, meta);
  const runPath = `runs/${run.id}.json`;
  await Bun.write(join(root, runPath), JSON.stringify(run, null, 2) + "\n");
  const benchmarkPath = join(root, "benchmark.json");
  if (!existsSync(benchmarkPath)) throw new Error(`benchmark.json not found at ${benchmarkPath}`);
  const benchmark = (await Bun.file(benchmarkPath).json()) as { runs?: string[] };
  const runs = benchmark.runs ?? [];
  if (!runs.includes(runPath)) {
    runs.push(runPath);
    benchmark.runs = runs;
    await Bun.write(benchmarkPath, JSON.stringify(benchmark, null, 2) + "\n");
  }
  console.log(`wrote ${runPath}`);
  for (const section of run.sections) console.log(`  ${section.id}: ${section.candidates.length} candidates, ${section.tests.length} tests, winner ${section.verdict.winnerId}`);
}
