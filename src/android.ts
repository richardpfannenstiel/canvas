import { writeFile } from "node:fs/promises";
import type { Backend, ButtonName, Device, UiElement } from "./device.js";
import { center } from "./device.js";
import type { Recording } from "./state.js";
import { isAlive, requireBin, run, runBuffer, runOk, sleep, spawnDetached, tryRun } from "./util.js";

/**
 * Android backend — plain `adb`, no extra tooling needed. `udid` is the adb
 * serial (e.g. `emulator-5554`); an AVD that is not running yet is addressed
 * by its AVD name and booted through the `emulator` binary.
 */

const adb = async (udid: string, args: string[], timeoutMs = 60_000): Promise<string> =>
  runOk(await requireBin("adb"), ["-s", udid, ...args], { timeoutMs });

/** adb without a target, for `devices` and friends. */
const adbRaw = async (args: string[], timeoutMs = 30_000): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  run(await requireBin("adb"), args, { timeoutMs });

/** Serials of every emulator adb currently knows about, booting ones included. */
async function emulatorSerials(): Promise<string[]> {
  const res = await tryRun(await requireBin("adb"), ["devices"], { timeoutMs: 15_000 });
  return (res?.stdout.split("\n").slice(1) ?? [])
    .map((l) => l.match(/^(emulator-\S+)\s+\S+/)?.[1])
    .filter((s): s is string => Boolean(s));
}

export const android: Backend = {
  platform: "android",

  async list(): Promise<Device[]> {
    const devices: Device[] = [];
    const running = await adbRaw(["devices", "-l"], 20_000);
    const online = new Set<string>();
    for (const line of running.stdout.split("\n").slice(1)) {
      const m = line.match(/^(\S+)\s+(device|offline|unauthorized)\b(.*)$/);
      if (!m) continue;
      const [, serial, status, rest] = m as unknown as [string, string, string, string];
      online.add(serial);
      const model = rest.match(/model:(\S+)/)?.[1]?.replace(/_/g, " ");
      let name = model ?? serial;
      if (serial.startsWith("emulator-")) {
        const avd = await adbRaw(["-s", serial, "emu", "avd", "name"], 10_000);
        const avdName = avd.stdout.split("\n")[0]?.trim();
        if (avdName && avdName !== "OK") name = avdName;
      }
      devices.push({
        udid: serial,
        name,
        platform: "android",
        state: status === "device" ? "booted" : "unknown",
        os: rest.match(/sdk:(\S+)/)?.[1],
      });
    }

    // AVDs that exist but are not running: addressable by name for `boot`.
    const avds = await run(await requireBin("emulator"), ["-list-avds"], { timeoutMs: 20_000 }).catch(() => null);
    for (const avd of avds?.stdout.split("\n") ?? []) {
      const name = avd.trim();
      if (!name || devices.some((d) => d.name === name)) continue;
      devices.push({ udid: name, name, platform: "android", state: "shutdown", os: "avd" });
    }
    return devices;
  },

  async boot(udid: string): Promise<string> {
    if (udid.startsWith("emulator-")) {
      await runOk(await requireBin("adb"), ["-s", udid, "wait-for-device"], { timeoutMs: 180_000 });
      return `${udid} is already running.`;
    }

    // Identify the new emulator by which serial appears, not by AVD name: the
    // name is only readable once the console is up, long after the serial is.
    const before = new Set(await emulatorSerials());
    // `-gpu host` matters: software rendering makes the emulator unusably slow.
    spawnDetached(await requireBin("emulator"), ["-avd", udid, "-gpu", "host", "-no-snapshot-save"]);

    let serial: string | undefined;
    for (let i = 0; i < 60 && !serial; i++) {
      await sleep(2_000);
      serial = (await emulatorSerials()).find((s) => !before.has(s));
    }
    if (!serial) throw new Error(`AVD "${udid}" never showed up in \`adb devices\` — check that it exists.`);

    for (let i = 0; i < 90; i++) {
      const prop = await tryRun(await requireBin("adb"), ["-s", serial, "shell", "getprop", "sys.boot_completed"], { timeoutMs: 5_000 });
      if (prop?.stdout.trim() === "1") return `Booted AVD "${udid}" as ${serial}.`;
      await sleep(2_000);
    }
    throw new Error(`AVD "${udid}" started as ${serial} but never finished booting.`);
  },

  async shutdown(udid: string): Promise<string> {
    await adb(udid, ["emu", "kill"], 30_000);
    return `Shut down ${udid}.`;
  },

  async screenshot(udid: string, outPath: string): Promise<void> {
    const png = await runBuffer(await requireBin("adb"), ["-s", udid, "exec-out", "screencap", "-p"], { timeoutMs: 45_000 });
    if (png.length === 0) throw new Error("screencap returned no data");
    await writeFile(outPath, png);
  },

  async describeUi(udid: string): Promise<UiElement[]> {
    const remote = "/sdcard/canvas-ui-dump.xml";
    await adb(udid, ["shell", "uiautomator", "dump", remote], 45_000);
    const xml = await adb(udid, ["shell", "cat", remote], 30_000);
    await adbRaw(["-s", udid, "shell", "rm", "-f", remote], 15_000);
    return parseUiAutomatorDump(xml);
  },

  async tap(udid: string, x: number, y: number): Promise<void> {
    await adb(udid, ["shell", "input", "tap", String(Math.round(x)), String(Math.round(y))], 30_000);
  },

  async swipe(udid, x1, y1, x2, y2, durationMs): Promise<void> {
    await adb(
      udid,
      ["shell", "input", "swipe", String(Math.round(x1)), String(Math.round(y1)), String(Math.round(x2)), String(Math.round(y2)), String(Math.round(durationMs))],
      30_000,
    );
  },

  async typeText(udid: string, text: string): Promise<void> {
    // `input text` treats spaces as argument separators; %s is its escape.
    await adb(udid, ["shell", "input", "text", text.replace(/ /g, "%s")], 45_000);
  },

  async pressButton(udid: string, button: ButtonName): Promise<void> {
    const keycodes: Record<ButtonName, number | null> = {
      home: 3,
      back: 4,
      power: 26,
      lock: 26,
      volume_up: 24,
      volume_down: 25,
      app_switch: 187,
      siri: null,
    };
    const code = keycodes[button];
    if (code === null) throw new Error(`Android has no equivalent for button "${button}".`);
    await adb(udid, ["shell", "input", "keyevent", String(code)], 30_000);
  },

  async installApp(udid: string, appPath: string): Promise<string> {
    const out = await adb(udid, ["install", "-r", appPath], 300_000);
    return out.trim() || `Installed ${appPath}.`;
  },

  async launchApp(udid: string, bundleId: string, forceRestart: boolean): Promise<string> {
    if (forceRestart) await adbRaw(["-s", udid, "shell", "am", "force-stop", bundleId], 30_000);
    // monkey reports a missing package on stderr with a bare non-zero exit, so
    // inspect the output ourselves rather than surfacing its argument dump.
    const res = await adbRaw(["-s", udid, "shell", "monkey", "-p", bundleId, "-c", "android.intent.category.LAUNCHER", "1"], 60_000);
    const output = `${res.stdout}\n${res.stderr}`;
    if (/No activities found|monkey aborted/i.test(output)) {
      throw new Error(`"${bundleId}" is not installed on ${udid}, or has no launcher activity.`);
    }
    if (res.code !== 0) throw new Error(`Could not launch "${bundleId}" (monkey exit ${res.code}).`);
    return `Launched ${bundleId}.`;
  },

  async openUrl(udid: string, url: string): Promise<void> {
    await adb(udid, ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url], 30_000);
  },

  async recordStart(udid: string, outPath: string): Promise<Recording> {
    const devicePath = `/sdcard/canvas-${Date.now()}.mp4`;
    // screenrecord caps out at 180s per file; the process must survive this call.
    const pid = spawnDetached(await requireBin("adb"), ["-s", udid, "shell", "screenrecord", "--time-limit", "180", devicePath]);
    await sleep(800);
    if (!isAlive(pid)) throw new Error("screenrecord exited immediately — is the device booted?");
    return { pid, outputPath: outPath, devicePath, platform: "android", udid, startedAt: new Date().toISOString() };
  },

  async recordStop(recording: Recording): Promise<string> {
    // SIGINT on the device-side process is what finalises the MP4 container.
    await adbRaw(["-s", recording.udid, "shell", "pkill", "-INT", "screenrecord"], 20_000);
    await sleep(2_000);
    if (isAlive(recording.pid)) process.kill(recording.pid, "SIGKILL");
    if (!recording.devicePath) throw new Error("recording has no device path");
    await runOk(await requireBin("adb"), ["-s", recording.udid, "pull", recording.devicePath, recording.outputPath], { timeoutMs: 120_000 });
    await adbRaw(["-s", recording.udid, "shell", "rm", "-f", recording.devicePath], 20_000);
    return recording.outputPath;
  },

  async logs(udid: string, lines: number, filter?: string): Promise<string> {
    const out = await adb(udid, ["logcat", "-d", "-t", String(Math.min(lines * 4, 4000)), "-v", "brief"], 45_000);
    const all = out.trim().split("\n");
    const matched = filter ? all.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : all;
    return matched.slice(-lines).join("\n");
  },
};

interface DumpNode {
  class?: string;
  text?: string;
  "resource-id"?: string;
  "content-desc"?: string;
  enabled?: string;
  clickable?: string;
  focusable?: string;
  bounds?: string;
}

/** Turn a `uiautomator dump` XML into the same flat shape the iOS side returns. */
export function parseUiAutomatorDump(xml: string): UiElement[] {
  const elements: UiElement[] = [];
  for (const match of xml.matchAll(/<node\b([^>]*?)(\/?)>/g)) {
    const isLeaf = match[2] === "/";
    const attrs: DumpNode = {};
    for (const attr of (match[1] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)) {
      (attrs as Record<string, string>)[attr[1] as string] = attr[2] as string;
    }
    const bounds = attrs.bounds?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (!bounds) continue;
    const [x1, y1, x2, y2] = bounds.slice(1, 5).map(Number) as [number, number, number, number];
    const frame = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    if (frame.width <= 0 || frame.height <= 0) continue;
    const label = attrs.text || attrs["content-desc"];
    // uiautomator dumps the whole view hierarchy, most of which is nested
    // FrameLayout/ScrollView scaffolding an agent can neither see nor act on.
    // Keep what is actually addressable: labelled nodes, clickable nodes, and
    // leaf nodes carrying a resource id (unlabelled inputs, image buttons).
    const addressable = Boolean(label) || attrs.clickable === "true" || (isLeaf && Boolean(attrs["resource-id"]));
    if (!addressable) continue;
    elements.push({
      type: attrs.class?.split(".").pop() ?? "View",
      label: label || undefined,
      identifier: attrs["resource-id"] || undefined,
      enabled: attrs.enabled === "true",
      frame,
      center: center(frame),
    });
  }
  return elements;
}
