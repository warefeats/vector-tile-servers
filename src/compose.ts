import { $ } from "bun";
import { type Engine, composeFile, composeProject, containerName } from "./matrix";

const COMPOSE_DIR = new URL("../compose/", import.meta.url).pathname;
const DB_PROJECT = "vts-db";
const DB_FILE = "docker-compose.db.yml";

function composeArgs(file: string, project: string): string[] {
  return ["docker", "compose", "--project-directory", COMPOSE_DIR, "-f", `${COMPOSE_DIR}${file}`, "-p", project];
}

function run(args: string[], opts: { timeoutMs?: number; quiet?: boolean } = {}): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: opts.quiet ? "pipe" : "inherit", timeout: opts.timeoutMs ?? 300_000 });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr?.toString() ?? "" };
}

export function dbUp(): void {
  const result = run([...composeArgs(DB_FILE, DB_PROJECT), "up", "-d", "db", "--wait", "--wait-timeout", "180"]);
  if (result.exitCode !== 0) throw new Error(`database compose up failed (exit ${result.exitCode})`);
}

export function dbLoad(corpus: string): void {
  const result = Bun.spawnSync([...composeArgs(DB_FILE, DB_PROJECT), "--profile", "load", "run", "--rm", "loader"], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, CORPUS: corpus },
    timeout: 3_600_000,
  });
  if (result.exitCode !== 0) throw new Error(`corpus import failed (exit ${result.exitCode})`);
}

export async function dbSql(sql: string, vars: Record<string, string> = {}): Promise<string> {
  const varArgs = Object.entries(vars).flatMap(([key, value]) => ["-v", `${key}=${value}`]);
  const args = [...composeArgs(DB_FILE, DB_PROJECT), "exec", "-T", "db", "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "bench", "-tA", ...varArgs, "-c", sql];
  const result = run(args, { quiet: true, timeoutMs: 3_600_000 });
  if (result.exitCode !== 0) throw new Error(`psql failed: ${result.stderr.slice(0, 500)}`);
  return result.stdout.trim();
}

export async function dbSqlFile(containerPath: string, vars: Record<string, string> = {}): Promise<void> {
  const varArgs = Object.entries(vars).flatMap(([key, value]) => ["-v", `${key}=${value}`]);
  const args = [...composeArgs(DB_FILE, DB_PROJECT), "exec", "-T", "db", "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "bench", ...varArgs, "-f", containerPath];
  const result = run(args, { quiet: true, timeoutMs: 3_600_000 });
  if (result.exitCode !== 0) throw new Error(`psql -f ${containerPath} failed: ${result.stderr.slice(0, 800)}`);
}

/** Pull or build the engine image without starting it, so cold-start timing never includes a pull. */
export function enginePrepare(engine: Engine): void {
  const base = composeArgs(composeFile(engine), composeProject(engine));
  if (engine === "bbox") {
    const built = Bun.spawnSync(["docker", "image", "inspect", "vts-bbox:0.6.2"], { stdout: "pipe", stderr: "pipe" });
    if (built.exitCode !== 0) {
      console.log("  building vts-bbox:0.6.2 from source (one-time, several minutes)");
      const build = run([...base, "build"], { timeoutMs: 3_600_000 });
      if (build.exitCode !== 0) throw new Error("bbox image build failed");
    }
    return;
  }
  const pull = run([...base, "pull", "--quiet"], { timeoutMs: 1_800_000 });
  if (pull.exitCode !== 0) throw new Error(`image pull failed for ${engine}`);
}

export function engineUp(engine: Engine): void {
  const result = run([...composeArgs(composeFile(engine), composeProject(engine)), "up", "-d", "--no-build"], { timeoutMs: 180_000 });
  if (result.exitCode !== 0) throw new Error(`compose up failed for ${engine} (exit ${result.exitCode})`);
}

export function engineDown(engine: Engine): void {
  run([...composeArgs(composeFile(engine), composeProject(engine)), "down", "--remove-orphans"], { quiet: true, timeoutMs: 120_000 });
}

export function engineLogs(engine: Engine, tail = 40): string {
  const result = run([...composeArgs(composeFile(engine), composeProject(engine)), "logs", "--no-color", "--tail", String(tail)], { quiet: true, timeoutMs: 30_000 });
  return result.stdout + result.stderr;
}

/** Container start time from Docker, as epoch milliseconds. */
export async function containerStartedAt(engine: Engine): Promise<number> {
  const raw = (await $`docker inspect --format {{.State.StartedAt}} ${containerName(engine)}`.text()).trim();
  const normalized = raw.replace(/(\.\d{3})\d*Z$/, "$1Z");
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) throw new Error(`unparseable StartedAt: ${raw}`);
  return parsed;
}

/** Resident memory of the engine container in MiB, from `docker stats`. */
export async function containerRssMb(engine: Engine): Promise<number> {
  const text = await $`docker stats ${containerName(engine)} --no-stream --format {{.MemUsage}}`.text().catch(() => "");
  const match = text.match(/([\d.]+)\s*(KiB|MiB|GiB)/);
  if (!match) return 0;
  const value = Number.parseFloat(match[1]!);
  switch (match[2]) {
    case "GiB":
      return value * 1024;
    case "KiB":
      return value / 1024;
    default:
      return value;
  }
}
