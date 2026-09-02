import { describe, expect, test } from "bun:test";
import { buildRun, orderResults, rigSlug, type RunMetadata } from "../src/import";
import { parseOha } from "../src/load-runner";
import type { Engine } from "../src/matrix";
import type { EngineResult, RawResults } from "../src/run";

function engineResult(engine: Engine, scale: number): EngineResult {
  const tile = (meanMs: number) => ({
    samplesMs: [meanMs * 0.9, meanMs, meanMs * 1.1],
    meanMs,
    p50Ms: meanMs,
    p99Ms: meanMs * 1.5,
    maxMs: meanMs * 2,
    requests: 15,
    errorRate: 0,
    bytesPerRequest: 40000,
  });
  const parity = { status: 200, bytes: 40000, contentType: "application/x-protobuf", contentEncoding: null, layers: [{ name: "buildings", version: 2, extent: 4096, features: 700, geometryTypes: { polygon: 700 } }], features: 700, gzip: { status: 200, bytes: 26000, contentEncoding: "gzip" } };
  return {
    engine,
    image: `${engine}:test`,
    startedAt: "2026-09-01T10:00:00.000Z",
    durationS: 60,
    coldStart: { samplesMs: [500 * scale, 520 * scale, 480 * scale], idleRssMb: 50 * scale },
    parity: { "buildings-z14": parity, "roads-z14": parity, "pois-z14": parity, "boundaries-z9": parity },
    single: { "buildings-z14": tile(20 * scale), "roads-z14": tile(15 * scale), "pois-z14": tile(10 * scale), "boundaries-z9": tile(30 * scale), "buildings-z14-gzip": tile(25 * scale) },
    burst: { samplesMs: [40 * scale, 42 * scale, 38 * scale], meanMs: 40 * scale, p50Ms: 40 * scale, maxMs: 42 * scale, slowestTileMeanMs: 30 * scale, errorRate: 0 },
    concurrency: {
      "10": { connections: 10, samplesP99Ms: [50 * scale, 55 * scale], samplesRps: [200 / scale, 210 / scale], rps: 205 / scale, p50Ms: 30 * scale, p99Ms: 52 * scale, errorRate: 0, completed: 4000, transportErrors: 0, statusCodes: { "200": 4000 }, errorDistribution: {}, minCompletedPerPass: 1900 },
      "100": { connections: 100, samplesP99Ms: [500 * scale, null], samplesRps: [220 / scale, 230 / scale], rps: 225 / scale, p50Ms: 300 * scale, p99Ms: 500 * scale, errorRate: 0.01, completed: 4400, transportErrors: 44, statusCodes: { "200": 4400 }, errorDistribution: { timeout: 44 }, minCompletedPerPass: 2100 },
    },
    rssAfterLoadMb: 80 * scale,
  };
}

const RAW: RawResults = {
  schemaVersion: 1,
  generatedAt: "2026-09-01T12:00:00.000Z",
  smoke: false,
  corpus: { buildings: 1, roads: 1, pois: 1, boundaries: 1 },
  tiles: [
    { id: "buildings-z14", layer: "buildings", z: 14, x: 8802, y: 5373 },
    { id: "roads-z14", layer: "roads", z: 14, x: 8802, y: 5373 },
    { id: "pois-z14", layer: "pois", z: 14, x: 8802, y: 5373 },
    { id: "boundaries-z9", layer: "boundaries", z: 9, x: 275, y: 167 },
  ],
  viewport: { layer: "buildings", tiles: [] },
  results: [engineResult("tegola", 3), engineResult("martin", 1)],
  failures: [],
};

const META: RunMetadata = {
  id: "2026-09-01-m2-max",
  label: "M2 Max (local)",
  publishedAt: "2026-09-01",
  environment: { machine: "MacBook Pro", chip: "Apple M2 Max", cores: "12", memory: "96 GB", os: "macOS", arch: "arm64", runtime: "Docker" },
  protocol: { warmups: 3, runs: 20, processModel: "x", cacheState: "y", output: "z" },
};

describe("run import", () => {
  const run = buildRun(orderResults(RAW), META);

  test("produces exactly the run-file keys", () => {
    expect(Object.keys(run).sort()).toEqual(["candidates", "environment", "id", "label", "protocol", "publishedAt", "schemaVersion", "sections"]);
    expect(run.candidates).toEqual([]);
  });

  test("orders engines the way the site lists them", () => {
    expect(run.sections[0]!.candidates.map((c) => c.id)).toEqual(["martin", "tegola"]);
  });

  test("builds the four sections with their tests", () => {
    expect(run.sections.map((s) => s.id)).toEqual(["single-tile-latency", "concurrency", "viewport-burst", "cold-start"]);
    expect(run.sections[0]!.tests.map((t) => t.id)).toEqual(["mean-buildings-z14", "mean-roads-z14", "mean-pois-z14", "mean-boundaries-z9", "mean-buildings-z14-gzip"]);
    expect(run.sections[1]!.tests.map((t) => t.id)).toEqual(["rps-c10", "rps-c100", "p99-c10", "p99-c100", "errors-c100"]);
    expect(run.sections[2]!.tests.map((t) => t.id)).toEqual(["burst-mean", "burst-max"]);
    expect(run.sections[3]!.tests.map((t) => t.id)).toEqual(["first-tile", "idle-rss", "loaded-rss"]);
  });

  test("picks the faster engine as every section's winner", () => {
    for (const section of run.sections) expect(section.verdict.winnerId).toBe("martin");
  });

  test("carries samples through and summarises them", () => {
    const martin = run.sections[0]!.candidates.find((c) => c.id === "martin")!;
    expect(martin.samplesMs).toEqual([18, 20, 22]);
    expect(martin.statistics).toEqual({ medianMs: 20, meanMs: 20, minMs: 18, maxMs: 22 });
    expect(martin.metrics?.["buildings-z14-bytes"]?.value).toBe(40000);
    expect(martin.metrics?.["buildings-z14-gzip-bytes"]?.value).toBe(26000);
    expect(martin.metrics?.["buildings-z14-gzip-mean"]?.value).toBe(25);
    const concurrency = run.sections[1]!.candidates.find((c) => c.id === "martin")!;
    expect(concurrency.samplesMs).toEqual([220, 230]);
    expect(run.sections[1]!.lowerIsBetter).toBe(false);
  });

  test("names the run after the rig", () => {
    expect(rigSlug("Apple M2 Max")).toBe("m2-max");
    expect(rigSlug("AWS Graviton3")).toBe("aws-graviton3");
  });
});

describe("oha parsing", () => {
  test("derives counts, rates and millisecond latencies", () => {
    const pass = parseOha(
      JSON.stringify({
        summary: { total: 12.0, slowest: 0.9, fastest: 0.01, average: 0.05, requestsPerSec: 100, sizePerRequest: 40000 },
        latencyPercentiles: { p50: 0.04, p99: 0.4 },
        statusCodeDistribution: { "200": 1180, "500": 20 },
        errorDistribution: { timeout: 5, "aborted due to deadline": 10 },
      }),
    );
    expect(pass.completed).toBe(1200);
    expect(pass.success).toBe(1180);
    expect(pass.transportErrors).toBe(5);
    expect(pass.abortedAtDeadline).toBe(10);
    expect(pass.p50Ms).toBe(40);
    expect(pass.p99Ms).toBe(400);
    expect(pass.meanMs).toBe(50);
    expect(pass.bytesPerRequest).toBe(40000);
  });

  test("reports null latencies when nothing completed", () => {
    const pass = parseOha(JSON.stringify({ summary: { total: 12, slowest: null, fastest: null, average: null, requestsPerSec: 0 }, statusCodeDistribution: {}, errorDistribution: { timeout: 100 } }));
    expect(pass.completed).toBe(0);
    expect(pass.p99Ms).toBeNull();
    expect(pass.meanMs).toBeNull();
  });
});
