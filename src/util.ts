import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * stdout is the JSON-RPC channel — anything written there corrupts the
 * protocol and the host drops the server. All diagnostics go to stderr,
 * where the host collects them as MCP server logs.
 */
export function log(...parts: unknown[]): void {
  process.stderr.write(`[canvas] ${parts.map(String).join(" ")}\n`);
}

export class CommandError extends Error {
  constructor(
    readonly cmd: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`\`${cmd}\` failed (exit ${code ?? "signal"}): ${stderr.trim() || "no stderr output"}`);
    this.name = "CommandError";
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
}

function spawnCollect(
  cmd: string,
  args: string[],
  opts: RunOptions,
): Promise<{ code: number | null; out: Buffer; err: string }> {
  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] };
    const child = spawn(cmd, args, spawnOpts);
    const out: Buffer[] = [];
    let err = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`\`${cmd} ${args.join(" ")}\` timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT}ms`));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT);

    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(`\`${cmd}\` not found on PATH. Run the \`doctor\` tool for install instructions.`)
          : e,
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: Buffer.concat(out), err });
    });
  });
}

const DEFAULT_TIMEOUT = 60_000;

/** Run a command, tolerating a non-zero exit code. */
export async function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { code, out, err } = await spawnCollect(cmd, args, opts);
  return { code, stdout: out.toString("utf8"), stderr: err };
}

/** Run a command and throw a descriptive error unless it exits 0. */
export async function runOk(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const res = await run(cmd, args, opts);
  if (res.code !== 0) throw new CommandError(`${cmd} ${args.join(" ")}`, res.code, res.stderr || res.stdout);
  return res.stdout;
}

/** Run a command, returning null instead of throwing on failure or timeout. */
export async function tryRun(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult | null> {
  try {
    return await run(cmd, args, opts);
  } catch {
    return null;
  }
}

/** Run a command whose stdout is binary (e.g. `adb exec-out screencap -p`). */
export async function runBuffer(cmd: string, args: string[], opts: RunOptions = {}): Promise<Buffer> {
  const { code, out, err } = await spawnCollect(cmd, args, opts);
  if (code !== 0) throw new CommandError(`${cmd} ${args.join(" ")}`, code, err);
  return out;
}

/** Absolute path of an executable on PATH, or null. */
export async function which(cmd: string): Promise<string | null> {
  const res = await run("/usr/bin/which", [cmd], { timeoutMs: 5_000 });
  const path = res.stdout.trim();
  return res.code === 0 && path ? path : null;
}

/* ------------------------------------------------------------ tool lookup */

/**
 * The server is spawned by the editor, not by a login shell, so PATH is often
 * far shorter than the one in the user's terminal — Android SDK tools in
 * particular are almost never on it. Look in the places these tools actually
 * live before giving up.
 */
export function androidSdkRoot(): string | null {
  const candidates = [
    process.env["ANDROID_HOME"],
    process.env["ANDROID_SDK_ROOT"],
    join(homedir(), "Library", "Android", "sdk"),
    join(homedir(), "Android", "Sdk"),
    "/usr/local/share/android-sdk",
  ].filter((c): c is string => Boolean(c));
  for (const dir of candidates) {
    if (existsSync(join(dir, "platform-tools")) || existsSync(join(dir, "emulator"))) return dir;
  }
  return null;
}

function fallbackPaths(name: string): string[] {
  const sdk = androidSdkRoot();
  const paths: Record<string, string[]> = {
    adb: sdk ? [join(sdk, "platform-tools", "adb")] : [],
    emulator: sdk ? [join(sdk, "emulator", "emulator")] : [],
    avdmanager: sdk ? [join(sdk, "cmdline-tools", "latest", "bin", "avdmanager")] : [],
    idb: [join(homedir(), ".local", "bin", "idb"), "/opt/homebrew/bin/idb", "/usr/local/bin/idb"],
    idb_companion: ["/opt/homebrew/bin/idb_companion", "/usr/local/bin/idb_companion"],
    ffmpeg: ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"],
    xcrun: ["/usr/bin/xcrun"],
    sips: ["/usr/bin/sips"],
  };
  return paths[name] ?? [];
}

const binCache = new Map<string, string | null>();

/** Resolve a tool to an absolute path: env override, then PATH, then known locations. */
export async function resolveBin(name: string): Promise<string | null> {
  const cached = binCache.get(name);
  if (cached !== undefined) return cached;

  const override = process.env[`CANVAS_${name.toUpperCase()}_PATH`];
  let found: string | null = override && existsSync(override) ? override : null;
  found ??= await which(name);
  found ??= fallbackPaths(name).find((p) => existsSync(p)) ?? null;

  binCache.set(name, found);
  if (found && !(await which(name))) log(`resolved ${name} outside PATH: ${found}`);
  return found;
}

/** Resolve a tool or throw with the install hint for it. */
export async function requireBin(name: string): Promise<string> {
  const path = await resolveBin(name);
  if (path) return path;
  throw new Error(`\`${name}\` not found. Run the \`doctor\` tool — it lists where canvas looked and how to install it.`);
}

export async function has(cmd: string): Promise<boolean> {
  return (await resolveBin(cmd)) !== null;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Start a long-running capture process that must outlive a single tool call.
 * Returns the PID; the process is detached so it survives even a server restart.
 */
export function spawnDetached(cmd: string, args: string[]): number {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
  if (child.pid === undefined) throw new Error(`could not start \`${cmd}\``);
  return child.pid;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
