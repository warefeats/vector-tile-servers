import { resolve } from "node:path";
import { type BenchmarkSection, type TestStatistic, buildSections, orderResults, validateResults } from "./import";
import { mean, percentile } from "./stats";

/**
 * Add per-pass samples to a run file published before the importer carried them. The sections are
 * rebuilt from the raw results the run was imported from, and the published file gains each test's
 * `statistic` and each result's `samples` from that build and nothing else: every published value
 * must equal the rebuilt one exactly, every sample array must summarize to its value under the
 * site's tolerance, and the file must already be in the importer's format, or it is left alone.
 */

/** What the enrich reads and writes in a published run; every other key rides along untouched. */
interface PublishedResult {
  candidateId: string;
  value: number;
  samples?: number[];
}

interface PublishedTest {
  id: string;
  results: PublishedResult[];
  statistic?: TestStatistic;
}

interface PublishedSection {
  id: string;
  tests: PublishedTest[];
}

export interface PublishedRun {
  sections: PublishedSection[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPublishedResult(value: unknown): value is PublishedResult {
  return isRecord(value) && typeof value.candidateId === "string" && typeof value.value === "number";
}

function isPublishedTest(value: unknown): value is PublishedTest {
  return isRecord(value) && typeof value.id === "string" && Array.isArray(value.results) && value.results.every(isPublishedResult);
}

function isPublishedSection(value: unknown): value is PublishedSection {
  return isRecord(value) && typeof value.id === "string" && Array.isArray(value.tests) && value.tests.every(isPublishedTest);
}

export function isPublishedRun(value: unknown): value is PublishedRun {
  return isRecord(value) && Array.isArray(value.sections) && value.sections.every(isPublishedSection);
}

/** The site's rule for a value it recomputes from samples: the two agree to half a unit in the value's last printed digit. */
export function agrees(value: number, computed: number): boolean {
  const text = String(value);
  const point = text.indexOf(".");
  const digits = point < 0 ? 0 : text.length - point - 1;
  return Math.abs(computed - value) <= 0.5 * 10 ** -digits + 1e-9;
}

function summarize(statistic: TestStatistic, samples: number[]): number | undefined {
  switch (statistic) {
    case "mean":
      return mean(samples);
    case "median":
      return percentile(samples, 0.5);
    case "min":
      return Math.min(...samples);
    case "max":
      return Math.max(...samples);
    case "other":
      return undefined;
  }
}

/** Add the statistic and samples of `fresh` to `published`, in place. Fresh tests and candidates the published run lacks are ignored. */
export function enrichRun(published: unknown, fresh: BenchmarkSection[]): PublishedRun {
  if (!isPublishedRun(published)) throw new Error("run file: not a run with sections, tests and results");
  for (const section of published.sections) {
    const freshSection = fresh.find((s) => s.id === section.id);
    if (!freshSection) throw new Error(`${section.id}: no such section in the rebuilt run`);
    for (const test of section.tests) {
      const where = `${section.id}/${test.id}`;
      const freshTest = freshSection.tests.find((t) => t.id === test.id);
      if (!freshTest) throw new Error(`${where}: no such test in the rebuilt run`);
      if (!freshTest.statistic) throw new Error(`${where}: the rebuilt test names no statistic`);
      if ("statistic" in test) throw new Error(`${where}: already carries a statistic`);
      for (const result of test.results) {
        const who = `${where} ${result.candidateId}`;
        const freshResult = freshTest.results.find((r) => r.candidateId === result.candidateId);
        if (!freshResult) throw new Error(`${who}: no such candidate in the rebuilt run`);
        if ("samples" in result) throw new Error(`${who}: already carries samples`);
        if (freshResult.value !== result.value) throw new Error(`${who}: the run file says ${result.value}, the results say ${freshResult.value}`);
        if (!freshResult.samples) continue;
        if (freshResult.samples.length === 0 || !freshResult.samples.every(Number.isFinite)) throw new Error(`${who}: the samples are empty or not all finite`);
        const computed = summarize(freshTest.statistic, freshResult.samples);
        if (computed !== undefined && !agrees(result.value, computed)) throw new Error(`${who}: the ${freshTest.statistic} of its samples is ${computed}, not ${result.value}`);
        result.samples = freshResult.samples;
      }
      test.statistic = freshTest.statistic;
    }
  }
  return published;
}

export interface Enrichment {
  /** Tests that name their statistic. */
  tests: number;
  /** Results that carry samples. */
  results: number;
}

/** Enrich the run file at `runPath` in place from the raw results at `resultsPath`. */
export async function enrichRunFile(runPath: string, resultsPath: string): Promise<Enrichment> {
  const text = await Bun.file(runPath).text();
  const published: unknown = JSON.parse(text);
  if (JSON.stringify(published, null, 2) + "\n" !== text) throw new Error(`${runPath}: not in the importer's format (two-space JSON ending in a newline), so a rewrite would change more than the two keys`);
  const raw = orderResults(validateResults(await Bun.file(resultsPath).json()));
  const run = enrichRun(published, buildSections(raw));
  await Bun.write(runPath, JSON.stringify(run, null, 2) + "\n");
  const tests = run.sections.flatMap((section) => section.tests);
  return { tests: tests.length, results: tests.flatMap((test) => test.results).filter((result) => result.samples !== undefined).length };
}

if (import.meta.main) {
  const runArg = process.argv.find((a) => a.startsWith("--run="))?.split("=")[1];
  const resultsArg = process.argv.find((a) => a.startsWith("--results="))?.split("=")[1];
  if (!runArg || !resultsArg) {
    console.error("usage: bun run src/enrich.ts --run=runs/<run>.json --results=results.json");
    process.exit(2);
  }
  try {
    const { tests, results } = await enrichRunFile(resolve(runArg), resolve(resultsArg));
    console.log(`enriched ${runArg}: ${tests} tests name their statistic, ${results} results carry samples`);
  } catch (error) {
    console.error(`enrich: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
