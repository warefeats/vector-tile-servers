import { request as httpRequest } from "node:http";
import { containerRssMb, containerStartedAt, engineDown, engineLogs, engineUp } from "./compose";
import { type Engine, type Layer, type Protocol, TILE_REQUEST_HEADERS, type TileSpec, VIEWPORT, tileUrl } from "./matrix";
import { type LayerSummary, summarizeTile, totalFeatures } from "./mvt";
import { mean, percentile, round } from "./stats";
import { gunzipSync } from "node:zlib";
import type { TileCoord } from "./tiles";

/** What oha reports for one invocation, in milliseconds and counts. */
export interface OhaPass {
  completed: number;
  success: number;
  /** Connection errors and timeouts. Requests oha itself cut off when the pass ended are not errors. */
  transportErrors: number;
  /** In-flight requests oha abandoned at the end of a fixed-duration pass. */
  abortedAtDeadline: number;
  statusCodes: Record<string, number>;
  errorDistribution: Record<string, number>;
  meanMs: number | null;
  p50Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  requestsPerSec: number;
  durationS: number;
  bytesPerRequest: number | null;
}

interface OhaJson {
  summary: { total: number; slowest: number; fastest: number; average: number; requestsPerSec: number; sizePerRequest?: number | null };
  latencyPercentiles?: Record<string, number>;
  statusCodeDistribution?: Record<string, number>;
  errorDistribution?: Record<string, number>;
}

/** oha's label for requests still in flight when a `-z` pass ends. */
export const OHA_DEADLINE_ABORT = "aborted due to deadline";

function finite(value: number | undefined | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseOha(json: string): OhaPass {
  const data = JSON.parse(json) as OhaJson;
  const statusCodes = data.statusCodeDistribution ?? {};
  const errorDistribution = data.errorDistribution ?? {};
  const completed = Object.values(statusCodes).reduce((a, b) => a + b, 0);
  const success = Object.entries(statusCodes).reduce((sum, [code, count]) => (code.startsWith("2") ? sum + count : sum), 0);
  const abortedAtDeadline = errorDistribution[OHA_DEADLINE_ABORT] ?? 0;
  const transportErrors = Object.entries(errorDistribution).reduce((sum, [kind, count]) => (kind === OHA_DEADLINE_ABORT ? sum : sum + count), 0);
  const toMs = (value: number | null) => (value === null ? null : round(value * 1000, 3));
  return {
    completed,
    success,
    transportErrors,
    abortedAtDeadline,
    statusCodes,
    errorDistribution,
    meanMs: completed > 0 ? toMs(finite(data.summary.average)) : null,
    p50Ms: completed > 0 ? toMs(finite(data.latencyPercentiles?.["p50"])) : null,
    p99Ms: completed > 0 ? toMs(finite(data.latencyPercentiles?.["p99"])) : null,
    maxMs: completed > 0 ? toMs(finite(data.summary.slowest)) : null,
    requestsPerSec: finite(data.summary.requestsPerSec) ?? 0,
    durationS: finite(data.summary.total) ?? 0,
    bytesPerRequest: finite(data.summary.sizePerRequest ?? null),
  };
}

export interface OhaOptions {
  connections: number;
  requests?: number;
  durationSeconds?: number;
  timeoutSeconds: number;
  headers?: Record<string, string>;
}

/** One oha invocation. Compression is disabled so every server returns the tile as generated. */
export function oha(url: string, opts: OhaOptions): OhaPass {
  const args = ["oha", "--output-format", "json", "--no-tui", "--disable-compression", "-t", `${opts.timeoutSeconds}s`, "-c", String(opts.connections)];
  if (opts.requests !== undefined) args.push("-n", String(opts.requests));
  if (opts.durationSeconds !== undefined) args.push("-z", `${opts.durationSeconds}s`);
  for (const [name, value] of Object.entries({ ...TILE_REQUEST_HEADERS, ...(opts.headers ?? {}) })) args.push("-H", `${name}: ${value}`);
  args.push(url);
  const budgetMs = ((opts.durationSeconds ?? 0) + opts.timeoutSeconds * (opts.requests !== undefined ? Math.ceil(opts.requests / opts.connections) + 1 : 2)) * 1000 + 30_000;
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: budgetMs });
  if (result.exitCode !== 0) throw new Error(`oha failed (exit ${result.exitCode}): ${result.stderr.toString().slice(0, 300)}`);
  return parseOha(result.stdout.toString());
}

export interface TileFetch {
  status: number;
  bytes: number;
  ms: number;
  contentType: string | null;
  contentEncoding: string | null;
  body: Uint8Array;
}

/**
 * One GET with the standard tile headers plus whatever is given, and nothing else. `fetch` would add
 * an Accept-Encoding header of its own, which changes what some servers return (Tegola gzips for
 * any value but an absent header), so the raw http client is used and the body is kept as sent.
 */
export function fetchTile(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<TileFetch> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "GET", headers: { ...TILE_REQUEST_HEADERS, ...(opts.headers ?? {}) }, timeout: opts.timeoutMs ?? 120_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = new Uint8Array(Buffer.concat(chunks));
        resolve({
          status: res.statusCode ?? 0,
          bytes: body.byteLength,
          ms: performance.now() - started,
          contentType: res.headers["content-type"] ?? null,
          contentEncoding: res.headers["content-encoding"] ?? null,
          body,
        });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`request timed out after ${opts.timeoutMs ?? 120_000} ms`)));
    req.on("error", reject);
    req.end();
  });
}

/** Poll until the URL answers 200. Returns the epoch millisecond at which it first did. */
export async function waitForTile(url: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchTile(url, { timeoutMs: 5_000 });
      if (response.status === 200) return Date.now();
    } catch {
      /* not up yet */
    }
    await Bun.sleep(50);
  }
  throw new Error(`no 200 from ${url} within ${timeoutMs} ms`);
}

export interface ColdStartResult {
  samplesMs: number[];
  idleRssMb: number;
}

/**
 * Start the engine container from a stopped state until it serves the marquee tile. The sample is
 * measured from Docker's container StartedAt (process start), so compose overhead is excluded.
 * The engine is left running after the last repetition.
 */
export async function runColdStart(engine: Engine, marquee: TileSpec, protocol: Protocol): Promise<ColdStartResult> {
  const url = tileUrl(engine, marquee.layer, marquee.tile);
  const samplesMs: number[] = [];
  for (let rep = 0; rep < protocol.coldStart.reps; rep++) {
    engineDown(engine);
    engineUp(engine);
    let firstTileAt: number;
    try {
      firstTileAt = await waitForTile(url, 300_000);
    } catch (error) {
      console.error(engineLogs(engine));
      throw error;
    }
    const startedAt = await containerStartedAt(engine);
    const ms = firstTileAt - startedAt;
    samplesMs.push(ms);
    console.log(`    cold start ${rep + 1}/${protocol.coldStart.reps}: ${ms} ms to first tile`);
  }
  await Bun.sleep(5_000);
  const idleRssMb = await containerRssMb(engine);
  console.log(`    idle RSS: ${idleRssMb.toFixed(1)} MiB`);
  return { samplesMs, idleRssMb };
}

export interface ParityResult {
  status: number;
  bytes: number;
  contentType: string | null;
  contentEncoding: string | null;
  layers: LayerSummary[];
  features: number;
  decodeError?: string;
  /** What the server sends when the client accepts gzip: encoding and transferred bytes. */
  gzip?: { status: number; bytes: number; contentEncoding: string | null };
}

/** Fetch each benchmark tile once and describe what came back: size, layers, feature counts. */
export async function runParity(engine: Engine, tiles: readonly TileSpec[]): Promise<Record<string, ParityResult>> {
  const out: Record<string, ParityResult> = {};
  for (const spec of tiles) {
    const url = tileUrl(engine, spec.layer, spec.tile);
    const fetched = await fetchTile(url);
    let layers: LayerSummary[] = [];
    let decodeError: string | undefined;
    if (fetched.status === 200) {
      try {
        layers = summarizeTile(fetched.contentEncoding === "gzip" ? new Uint8Array(gunzipSync(fetched.body)) : fetched.body);
      } catch (error) {
        decodeError = error instanceof Error ? error.message : String(error);
      }
    }
    const gz = await fetchTile(url, { headers: { "Accept-Encoding": "gzip" } });
    out[spec.id] = {
      status: fetched.status,
      bytes: fetched.bytes,
      contentType: fetched.contentType,
      contentEncoding: fetched.contentEncoding,
      layers,
      features: totalFeatures(layers),
      ...(decodeError ? { decodeError } : {}),
      gzip: { status: gz.status, bytes: gz.bytes, contentEncoding: gz.contentEncoding },
    };
    console.log(`    parity ${spec.id}: ${fetched.status} ${fetched.bytes} B${fetched.contentEncoding ? ` (${fetched.contentEncoding})` : ""}, ${totalFeatures(layers)} features in ${layers.length} layer(s); gzip-negotiated ${gz.bytes} B${decodeError ? ` (decode error: ${decodeError})` : ""}`);
  }
  return out;
}

export interface SingleTileResult {
  /** Mean latency of each measured pass, ms. */
  samplesMs: number[];
  meanMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  requests: number;
  errorRate: number;
  bytesPerRequest: number | null;
}

/** Sequential requests on one tile (one connection): the thesis's single-user tests. */
export function runSingleTile(engine: Engine, spec: TileSpec, protocol: Protocol, headers?: Record<string, string>): SingleTileResult {
  const url = tileUrl(engine, spec.layer, spec.tile);
  const { warmupPasses, passes, requestsPerPass } = protocol.single;
  const opts: OhaOptions = { connections: 1, requests: requestsPerPass, timeoutSeconds: protocol.requestTimeoutSeconds, ...(headers ? { headers } : {}) };
  for (let i = 0; i < warmupPasses; i++) oha(url, opts);
  const samplesMs: number[] = [];
  const p99s: number[] = [];
  const p50s: number[] = [];
  const maxes: number[] = [];
  let requests = 0;
  let failures = 0;
  let bytes: number | null = null;
  for (let i = 0; i < passes; i++) {
    const pass = oha(url, opts);
    requests += pass.completed + pass.transportErrors;
    failures += pass.completed - pass.success + pass.transportErrors;
    if (pass.meanMs !== null) samplesMs.push(pass.meanMs);
    if (pass.p50Ms !== null) p50s.push(pass.p50Ms);
    if (pass.p99Ms !== null) p99s.push(pass.p99Ms);
    if (pass.maxMs !== null) maxes.push(pass.maxMs);
    if (pass.bytesPerRequest !== null) bytes = pass.bytesPerRequest;
  }
  const result: SingleTileResult = {
    samplesMs,
    meanMs: round(mean(samplesMs), 3),
    p50Ms: round(percentile(p50s, 0.5), 3),
    p99Ms: round(Math.max(...p99s), 3),
    maxMs: round(Math.max(...maxes), 3),
    requests,
    errorRate: requests > 0 ? round(failures / requests, 4) : 1,
    bytesPerRequest: bytes,
  };
  console.log(`    ${spec.id}${headers ? " (gzip)" : ""} c=1: mean ${result.meanMs} ms, p99 ${result.p99Ms} ms over ${requests} requests, errors ${(result.errorRate * 100).toFixed(1)}%`);
  return result;
}

export interface BurstResult {
  /** Wall time for all four tiles to arrive, per repetition, ms. */
  samplesMs: number[];
  meanMs: number;
  p50Ms: number;
  maxMs: number;
  /** Mean of the slowest single tile within a burst, ms. */
  slowestTileMeanMs: number;
  errorRate: number;
}

/** The thesis's test 2: four adjacent tiles requested at once, as a map view would. */
export async function runBurst(engine: Engine, protocol: Protocol): Promise<BurstResult> {
  const urls = VIEWPORT.tiles.map((tile) => tileUrl(engine, VIEWPORT.layer, tile));
  const rep = async (): Promise<{ wallMs: number; slowestMs: number; failures: number }> => {
    const started = performance.now();
    const results = await Promise.all(urls.map((url) => fetchTile(url, { timeoutMs: protocol.requestTimeoutSeconds * 1000 }).catch(() => null)));
    const wallMs = performance.now() - started;
    const slowestMs = Math.max(...results.map((r) => r?.ms ?? wallMs));
    const failures = results.filter((r) => r === null || r.status !== 200).length;
    return { wallMs, slowestMs, failures };
  };
  for (let i = 0; i < protocol.burst.warmups; i++) await rep();
  const samplesMs: number[] = [];
  const slowest: number[] = [];
  let failures = 0;
  for (let i = 0; i < protocol.burst.reps; i++) {
    const r = await rep();
    samplesMs.push(round(r.wallMs, 3));
    slowest.push(r.slowestMs);
    failures += r.failures;
  }
  const result: BurstResult = {
    samplesMs,
    meanMs: round(mean(samplesMs), 3),
    p50Ms: round(percentile(samplesMs, 0.5), 3),
    maxMs: round(Math.max(...samplesMs), 3),
    slowestTileMeanMs: round(mean(slowest), 3),
    errorRate: round(failures / (protocol.burst.reps * urls.length), 4),
  };
  console.log(`    viewport burst: mean ${result.meanMs} ms, max ${result.maxMs} ms over ${protocol.burst.reps} reps`);
  return result;
}

export interface ConcurrencyResult {
  connections: number;
  /** p99 latency of each measured pass, ms; null when a pass completed no request. */
  samplesP99Ms: (number | null)[];
  /** Successful (2xx) requests per second in each measured pass. */
  samplesRps: number[];
  rps: number;
  p50Ms: number | null;
  p99Ms: number | null;
  errorRate: number;
  completed: number;
  transportErrors: number;
  statusCodes: Record<string, number>;
  errorDistribution: Record<string, number>;
  minCompletedPerPass: number;
}

/** Closed-loop load on the marquee tile at a fixed number of connections. */
export function runConcurrency(engine: Engine, spec: TileSpec, connections: number, protocol: Protocol): ConcurrencyResult {
  const url = tileUrl(engine, spec.layer, spec.tile);
  const { warmupSeconds, passes, passSeconds } = protocol.concurrency;
  const timeoutSeconds = protocol.requestTimeoutSeconds;
  oha(url, { connections, durationSeconds: warmupSeconds, timeoutSeconds });
  const samplesP99Ms: (number | null)[] = [];
  const samplesRps: number[] = [];
  const p50s: number[] = [];
  const p99s: number[] = [];
  const statusCodes: Record<string, number> = {};
  const errorDistribution: Record<string, number> = {};
  let completed = 0;
  let success = 0;
  let transportErrors = 0;
  let minCompletedPerPass = Number.POSITIVE_INFINITY;
  for (let i = 0; i < passes; i++) {
    const pass = oha(url, { connections, durationSeconds: passSeconds, timeoutSeconds });
    samplesP99Ms.push(pass.p99Ms);
    samplesRps.push(round(pass.success / passSeconds, 2));
    if (pass.p50Ms !== null) p50s.push(pass.p50Ms);
    if (pass.p99Ms !== null) p99s.push(pass.p99Ms);
    completed += pass.completed;
    success += pass.success;
    transportErrors += pass.transportErrors;
    minCompletedPerPass = Math.min(minCompletedPerPass, pass.completed);
    for (const [code, count] of Object.entries(pass.statusCodes)) statusCodes[code] = (statusCodes[code] ?? 0) + count;
    for (const [error, count] of Object.entries(pass.errorDistribution)) {
      if (error === OHA_DEADLINE_ABORT) continue;
      errorDistribution[error] = (errorDistribution[error] ?? 0) + count;
    }
  }
  const total = completed + transportErrors;
  const result: ConcurrencyResult = {
    connections,
    samplesP99Ms,
    samplesRps,
    rps: round(mean(samplesRps), 2),
    p50Ms: p50s.length ? round(percentile(p50s, 0.5), 3) : null,
    p99Ms: p99s.length ? round(percentile(p99s, 0.5), 3) : null,
    errorRate: total > 0 ? round((total - success) / total, 4) : 1,
    completed,
    transportErrors,
    statusCodes,
    errorDistribution,
    minCompletedPerPass: Number.isFinite(minCompletedPerPass) ? minCompletedPerPass : 0,
  };
  console.log(`    c=${connections}: ${result.rps} req/s, p50 ${result.p50Ms ?? "n/a"} ms, p99 ${result.p99Ms ?? "n/a"} ms, errors ${(result.errorRate * 100).toFixed(2)}%`);
  return result;
}

