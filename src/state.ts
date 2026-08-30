import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "./util.js";

export type Platform = "ios" | "android";

export interface Recording {
  /** PID of the detached capture process (iOS) or of the `adb shell` client (Android). */
  pid: number;
  /** Where the finished file will land on the host. */
  outputPath: string;
  /** Android only: the on-device path that still has to be pulled. */
  devicePath?: string;
  platform: Platform;
  udid: string;
  startedAt: string;
}

export interface State {
  selected?: { udid: string; platform: Platform; name: string };
  recording?: Recording;
}

/**
 * A stdio MCP server is spawned per session, so anything that should survive a
 * session restart — the selected device, a detached recording — lives here.
 */
const STATE_FILE = join(homedir(), ".canvas-mcp", "state.json");

export async function readState(): Promise<State> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as State;
  } catch {
    return {};
  }
}

export async function writeState(next: State): Promise<void> {
  try {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(next, null, 2));
  } catch (e) {
    log("could not persist state:", e);
  }
}

export async function patchState(patch: Partial<State>): Promise<State> {
  const next = { ...(await readState()), ...patch };
  for (const key of Object.keys(patch) as (keyof State)[]) {
    if (patch[key] === undefined) delete next[key];
  }
  await writeState(next);
  return next;
}
