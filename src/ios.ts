import { rm } from "node:fs/promises";
import type { Backend, ButtonName, Device, UiElement } from "./device.js";
import { center } from "./device.js";
import type { Recording } from "./state.js";
import { CommandError, has, isAlive, log, requireBin, run, runOk, sleep, spawnDetached } from "./util.js";

/**
 * iOS backend.
 *
 * Split of responsibilities:
 *   - `idb`   — everything simctl cannot do: tap/swipe/text/buttons and the
 *               accessibility tree. Requires `brew install facebook/fb/idb`.
 *   - `simctl`— lifecycle, install/launch, screenshots, video, logs. Always
 *               present with Xcode, and used as the fallback whenever idb is
 *               missing, so the plugin stays useful without extra setup.
 */

let idbAvailable: boolean | null = null;

export async function hasIdb(): Promise<boolean> {
  if (idbAvailable === null) idbAvailable = await has("idb");
  return idbAvailable;
}

async function requireIdb(action: string): Promise<void> {
  if (await hasIdb()) return;
  throw new Error(
    `\`${action}\` needs idb, which is not on PATH. Install it with:\n` +
      `  brew tap facebook/fb && brew install idb-companion\n` +
      `  pipx install fb-idb   (or: pip3 install fb-idb)\n` +
      `Everything else (boot, screenshot, install, launch, record, logs) works without idb.`,
  );
}

const idb = async (args: string[], timeoutMs = 60_000): Promise<string> =>
  runOk(await requireBin("idb"), args, { timeoutMs });
const simctl = async (args: string[], timeoutMs = 120_000): Promise<string> =>
  runOk(await requireBin("xcrun"), ["simctl", ...args], { timeoutMs });
const simctlRaw = async (args: string[], timeoutMs = 120_000) =>
  run(await requireBin("xcrun"), ["simctl", ...args], { timeoutMs });

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
}

function normalizeState(raw: string): Device["state"] {
  const s = raw.toLowerCase();
  if (s.includes("boot")) return "booted";
  if (s.includes("shutdown")) return "shutdown";
  return "unknown";
}

export const ios: Backend = {
  platform: "ios",

  async list(): Promise<Device[]> {
    const out = await simctl(["list", "devices", "available", "--json"], 30_000);
    const parsed = JSON.parse(out) as { devices: Record<string, SimctlDevice[]> };
    const devices: Device[] = [];
    for (const [runtime, entries] of Object.entries(parsed.devices)) {
      // "com.apple.CoreSimulator.SimRuntime.iOS-17-4" -> "iOS 17.4"
      const os = runtime.split(".").pop()?.replace(/-/, " ").replace(/-/g, ".") ?? runtime;
      for (const d of entries) {
        if (d.isAvailable === false) continue;
        devices.push({ udid: d.udid, name: d.name, platform: "ios", state: normalizeState(d.state), os });
      }
    }
    return devices;
  },

  async boot(udid: string): Promise<string> {
    const res = await simctlRaw(["boot", udid], 180_000);
    if (res.code !== 0 && !/Unable to boot device in current state: Booted/i.test(res.stderr)) {
      throw new CommandError(`simctl boot ${udid}`, res.code, res.stderr);
    }
    // Bring up Simulator.app so the device is visible; harmless if already open.
    await run("open", ["-a", "Simulator"], { timeoutMs: 20_000 });
    await simctl(["bootstatus", udid], 180_000);
    return `Booted ${udid}.`;
  },

  async shutdown(udid: string): Promise<string> {
    const res = await simctlRaw(["shutdown", udid], 60_000);
    if (res.code !== 0 && !/current state: Shutdown/i.test(res.stderr)) {
      throw new CommandError(`simctl shutdown ${udid}`, res.code, res.stderr);
    }
    return `Shut down ${udid}.`;
  },

  async screenshot(udid: string, outPath: string): Promise<void> {
    if (await hasIdb()) {
      try {
        await idb(["screenshot", "--udid", udid, outPath], 30_000);
        return;
      } catch (e) {
        log("idb screenshot failed, falling back to simctl:", e);
      }
    }
    await simctl(["io", udid, "screenshot", "--type", "png", outPath], 30_000);
  },

  async describeUi(udid: string): Promise<UiElement[]> {
    await requireIdb("describe_ui");
    const out = await idb(["ui", "describe-all", "--udid", udid, "--json"], 45_000);
    return parseIdbTree(out);
  },

  async tap(udid: string, x: number, y: number): Promise<void> {
    await requireIdb("tap");
    await idb(["ui", "tap", "--udid", udid, String(Math.round(x)), String(Math.round(y))], 30_000);
  },

  async swipe(udid, x1, y1, x2, y2, durationMs): Promise<void> {
    await requireIdb("swipe");
    const seconds = (durationMs / 1000).toFixed(2);
    await idb(
      [
        "ui", "swipe", "--udid", udid,
        "--duration", seconds,
        String(Math.round(x1)), String(Math.round(y1)),
        String(Math.round(x2)), String(Math.round(y2)),
      ],
      30_000,
    );
  },

  async typeText(udid: string, text: string): Promise<void> {
    await requireIdb("type_text");
    await idb(["ui", "text", "--udid", udid, text], 45_000);
  },

  async pressButton(udid: string, button: ButtonName): Promise<void> {
    await requireIdb("press_button");
    const map: Partial<Record<ButtonName, string>> = {
      home: "HOME",
      lock: "LOCK",
      power: "LOCK",
      siri: "SIRI",
      volume_up: "SIDE_BUTTON",
      volume_down: "SIDE_BUTTON",
    };
    const name = map[button];
    if (!name) throw new Error(`iOS has no equivalent for button "${button}" (try: home, lock, siri).`);
    await idb(["ui", "button", "--udid", udid, name], 30_000);
  },

  async installApp(udid: string, appPath: string): Promise<string> {
    await simctl(["install", udid, appPath], 180_000);
    return `Installed ${appPath}.`;
  },

  async launchApp(udid: string, bundleId: string, forceRestart: boolean): Promise<string> {
    if (forceRestart) await simctlRaw(["terminate", udid, bundleId], 30_000);
    const out = await simctl(["launch", udid, bundleId], 60_000);
    return out.trim() || `Launched ${bundleId}.`;
  },

  async openUrl(udid: string, url: string): Promise<void> {
    await simctl(["openurl", udid, url], 30_000);
  },

  async recordStart(udid: string, outPath: string): Promise<Recording> {
    // simctl finalises the file on SIGINT, so the process must outlive this call.
    const pid = spawnDetached(await requireBin("xcrun"), ["simctl", "io", udid, "recordVideo", "--codec", "h264", "--force", outPath]);
    await sleep(600);
    if (!isAlive(pid)) throw new Error("recording process exited immediately — is the device booted?");
    return { pid, outputPath: outPath, platform: "ios", udid, startedAt: new Date().toISOString() };
  },

  async recordStop(recording: Recording): Promise<string> {
    if (isAlive(recording.pid)) {
      process.kill(recording.pid, "SIGINT");
      for (let i = 0; i < 40 && isAlive(recording.pid); i++) await sleep(250);
      if (isAlive(recording.pid)) process.kill(recording.pid, "SIGKILL");
    }
    return recording.outputPath;
  },

  async logs(udid: string, lines: number, filter?: string): Promise<string> {
    // `log stream` never returns, so read a bounded window instead.
    const args = ["spawn", udid, "log", "show", "--last", "2m", "--style", "compact"];
    if (filter) args.push("--predicate", `eventMessage CONTAINS[c] "${filter.replace(/"/g, '\\"')}"`);
    const res = await simctlRaw(args, 60_000);
    const all = (res.stdout || res.stderr).trim().split("\n");
    return all.slice(-lines).join("\n");
  },
};

/** Cleanup helper for a screenshot temp file that failed to be produced. */
export async function discard(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => {});
}

interface IdbNode {
  AXLabel?: string | null;
  AXUniqueId?: string | null;
  AXValue?: string | null;
  type?: string | null;
  role_description?: string | null;
  enabled?: boolean;
  frame?: { x: number; y: number; width: number; height: number };
  AXFrame?: string | null;
}

/**
 * `idb ui describe-all` emits either a JSON array or one object per line,
 * depending on version — and the frame is either a `frame` object or an
 * `AXFrame` string like `{{0, 44}, {393, 44}}`. Handle all of it.
 */
export function parseIdbTree(raw: string): UiElement[] {
  const nodes: IdbNode[] = [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as IdbNode | IdbNode[];
    nodes.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  } catch {
    for (const line of trimmed.split("\n")) {
      const l = line.trim();
      if (!l.startsWith("{")) continue;
      try {
        nodes.push(JSON.parse(l) as IdbNode);
      } catch {
        /* skip partial lines */
      }
    }
  }

  const elements: UiElement[] = [];
  for (const n of nodes) {
    const frame = n.frame ?? parseAxFrame(n.AXFrame ?? undefined);
    if (!frame || frame.width <= 0 || frame.height <= 0) continue;
    elements.push({
      type: n.type ?? n.role_description ?? "Element",
      label: n.AXLabel ?? undefined,
      identifier: n.AXUniqueId ?? undefined,
      value: n.AXValue ?? undefined,
      enabled: n.enabled,
      frame,
      center: center(frame),
    });
  }
  return elements;
}

function parseAxFrame(s?: string): UiElement["frame"] | null {
  if (!s) return null;
  const nums = s.match(/-?\d+(\.\d+)?/g);
  if (!nums || nums.length < 4) return null;
  const [x, y, width, height] = nums.slice(0, 4).map(Number) as [number, number, number, number];
  return { x, y, width, height };
}
