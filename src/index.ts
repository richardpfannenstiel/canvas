import { mkdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { android } from "./android.js";
import type { Backend, ButtonName, Device, UiElement } from "./device.js";
import { encodeScreenshot, type ImageFormat } from "./image.js";
import { hasIdb, ios } from "./ios.js";
import { patchState, readState, type Platform } from "./state.js";
import { androidSdkRoot, has, isAlive, log, resolveBin } from "./util.js";

const VERSION = "0.1.0";

const backends: Record<Platform, Backend> = { ios, android };

/* ------------------------------------------------------------------ target */

interface Target {
  device: Device;
  backend: Backend;
}

/**
 * Enumerating devices costs a `simctl list` plus an `adb devices` round trip.
 * A UI loop calls resolveTarget on every tap, so cache briefly — device sets
 * do not change on a sub-second timescale.
 */
const LIST_TTL_MS = 3_000;
const listCache = new Map<string, { at: number; devices: Device[] }>();
const listFailures = new Set<Platform>();

async function listAll(platform?: Platform, fresh = false): Promise<Device[]> {
  const key = platform ?? "all";
  const cached = listCache.get(key);
  if (!fresh && cached && Date.now() - cached.at < LIST_TTL_MS) return cached.devices;

  const wanted: Platform[] = platform ? [platform] : ["ios", "android"];
  const results = await Promise.all(
    wanted.map(async (p) => {
      try {
        const devices = await backends[p].list();
        listFailures.delete(p);
        return devices;
      } catch (e) {
        // Missing adb/Xcode is the normal case on a single-platform machine —
        // say so once, not on every tool call.
        if (!listFailures.has(p)) {
          listFailures.add(p);
          log(`listing ${p} devices failed (silenced until it recovers):`, e instanceof Error ? e.message : e);
        }
        return [];
      }
    }),
  );
  const devices = results.flat();
  listCache.set(key, { at: Date.now(), devices });
  return devices;
}

function invalidateDeviceCache(): void {
  listCache.clear();
}

/**
 * Resolve which device a tool acts on: an explicit udid wins, then the stored
 * selection, then — only if it is unambiguous — the single booted device.
 */
async function resolveTarget(udid?: string): Promise<Target> {
  const devices = await listAll();
  const byId = (id: string): Device | undefined =>
    devices.find((d) => d.udid === id) ?? devices.find((d) => d.name === id);

  if (udid) {
    const device = byId(udid);
    if (!device) throw new Error(`No device with udid or name "${udid}". Run \`list_devices\` to see what is available.`);
    return { device, backend: backends[device.platform] };
  }

  const stored = (await readState()).selected;
  if (stored) {
    const device = byId(stored.udid);
    if (device) return { device, backend: backends[device.platform] };
    log(`stored selection ${stored.udid} is gone, falling back to auto-detect`);
  }

  const booted = devices.filter((d) => d.state === "booted");
  if (booted.length === 1) return { device: booted[0] as Device, backend: backends[(booted[0] as Device).platform] };
  if (booted.length === 0) throw new Error("No booted device. Boot one with `boot`, or pass an explicit udid.");
  throw new Error(
    `${booted.length} devices are booted — pick one with \`select_device\`:\n` +
      booted.map((d) => `  ${d.udid}  ${d.name} (${d.platform})`).join("\n"),
  );
}

/* ----------------------------------------------------------------- helpers */

async function screenshotPath(udid: string): Promise<string> {
  const dir = join(tmpdir(), "canvas-screenshots");
  await mkdir(dir, { recursive: true });
  return join(dir, `${udid}-${Date.now()}.png`);
}

async function defaultRecordingPath(): Promise<string> {
  const desktop = join(homedir(), "Desktop");
  const dir = await stat(desktop).then((s) => s.isDirectory()).catch(() => false) ? desktop : tmpdir();
  return join(dir, `canvas-recording-${Date.now()}.mp4`);
}

function describeDevice(d: Device): string {
  return `${d.udid}  ${d.name}${d.os ? ` [${d.os}]` : ""}  (${d.platform}, ${d.state})`;
}

function renderElements(elements: UiElement[], limit: number): string {
  const rows = elements.slice(0, limit).map((e) => {
    const parts = [`${e.center.x},${e.center.y}`.padEnd(11), e.type.padEnd(18)];
    if (e.label) parts.push(`"${e.label}"`);
    if (e.identifier) parts.push(`#${e.identifier}`);
    if (e.value) parts.push(`= ${e.value}`);
    if (e.enabled === false) parts.push("(disabled)");
    return "  " + parts.join(" ");
  });
  const header = `${elements.length} elements (tap coordinates first):`;
  const footer = elements.length > limit ? `\n  … ${elements.length - limit} more (raise max_elements)` : "";
  return [header, ...rows].join("\n") + footer;
}

/**
 * Rank candidates for `tap_element`. A substring query typically hits several
 * nodes — the control itself, its label, and the container around both. Prefer
 * an exact label over a partial one, a real control over a layout wrapper, and
 * a small target over a full-screen container.
 */
function scoreMatch(e: UiElement, needle: string): number {
  const label = e.label?.toLowerCase() ?? "";
  const id = e.identifier?.toLowerCase() ?? "";
  let score = 0;
  if (label === needle) score += 100;
  else if (label.startsWith(needle)) score += 70;
  else if (label.includes(needle)) score += 50;
  if (id === needle) score += 45;
  else if (id.includes(needle)) score += 20;
  if (score === 0) return 0;

  if (/button|edittext|textfield|securetextfield|checkbox|switch|link|cell|menuitem|tab|searchfield/i.test(e.type)) score += 25;
  if (/layout|group|scrollview|image|application|window/i.test(e.type)) score -= 20;
  if (e.enabled === false) score -= 30;
  // A match covering most of the screen is the container, not the control.
  if (e.frame.width * e.frame.height > 500_000) score -= 15;
  return score;
}

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const text = (s: string): { content: Content[] } => ({ content: [{ type: "text", text: s }] });

/* ------------------------------------------------------------------ server */

const server = new McpServer({ name: "canvas", version: VERSION });

function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: S,
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<{ content: Content[] }>,
): void {
  const callback = async (args: unknown): Promise<unknown> => {
    try {
      return await handler(args as z.objectOutputType<S, z.ZodTypeAny>);
    } catch (e) {
      // Surface failures as tool results, not protocol errors: the agent can
      // read the message and correct course instead of losing the turn.
      const message = e instanceof Error ? e.message : String(e);
      log(`${name} failed:`, message);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  };
  server.registerTool(name, { description, inputSchema: schema }, callback as never);
}

const udidArg = z.string().optional().describe("Device udid or name. Defaults to the selected device.");

/* -------------------------------------------------------------------- tools */

tool("doctor", "Check which simulator tooling is installed and what each missing piece would unlock.", {}, async () => {
  const checks = [
    { bin: "xcrun", what: "iOS lifecycle, install, screenshots, video, logs", fix: "Install Xcode from the App Store." },
    { bin: "idb", what: "iOS tap / swipe / type / UI tree", fix: "brew tap facebook/fb && brew install idb-companion && pipx install fb-idb" },
    { bin: "idb_companion", what: "idb's per-device backend", fix: "brew tap facebook/fb && brew install idb-companion" },
    { bin: "adb", what: "all Android control", fix: "Install Android Studio, then add platform-tools to PATH." },
    { bin: "emulator", what: "booting Android AVDs by name", fix: "Install the Android SDK emulator package." },
    { bin: "ffmpeg", what: "screenshot downscaling (sips is used otherwise)", fix: "brew install ffmpeg" },
  ];
  const lines: string[] = [`canvas ${VERSION}`, ""];
  for (const c of checks) {
    const path = await resolveBin(c.bin);
    lines.push(path ? `  ok      ${c.bin.padEnd(14)} ${path}` : `  MISSING ${c.bin.padEnd(14)} ${c.what}\n          fix: ${c.fix}`);
  }
  const sdk = androidSdkRoot();
  if (sdk) lines.push("", `Android SDK: ${sdk}`);
  const devices = await listAll();
  const booted = devices.filter((d) => d.state === "booted");
  lines.push("", `${devices.length} devices visible, ${booted.length} booted.`);
  lines.push(...booted.map((d) => "  " + describeDevice(d)));
  const state = await readState();
  if (state.selected) lines.push("", `Selected: ${state.selected.udid} (${state.selected.name})`);
  if (state.recording) {
    lines.push(`Recording: ${state.recording.outputPath} (pid ${state.recording.pid}, ${isAlive(state.recording.pid) ? "running" : "dead"})`);
  }
  return text(lines.join("\n"));
});

tool(
  "list_devices",
  "List iOS Simulators and Android emulators, with their udid, name and boot state.",
  {
    platform: z.enum(["ios", "android", "all"]).optional().describe("Defaults to all."),
    filter: z.string().optional().describe('Substring match on name or OS version, e.g. "iPhone 17" or "26.1".'),
    limit: z.number().int().min(1).max(500).optional().describe("Cap on non-booted devices listed. Default 25."),
  },
  async ({ platform, filter, limit }) => {
    const devices = await listAll(platform && platform !== "all" ? platform : undefined, true);
    if (devices.length === 0) return text("No devices found. Run `doctor` to check the tooling.");
    const needle = filter?.toLowerCase();
    const matching = needle
      ? devices.filter((d) => `${d.name} ${d.os ?? ""}`.toLowerCase().includes(needle))
      : devices;
    // Booted devices are always listed in full; a fresh Xcode install carries
    // 100+ shutdown simulators, and dumping all of them is pure token burn.
    const booted = matching.filter((d) => d.state === "booted");
    const rest = matching.filter((d) => d.state !== "booted");
    const cap = limit ?? 25;
    const lines = [
      ...(booted.length ? ["BOOTED:", ...booted.map((d) => "  " + describeDevice(d))] : []),
      ...(rest.length ? [`AVAILABLE (${rest.length}):`, ...rest.slice(0, cap).map((d) => "  " + describeDevice(d))] : []),
    ];
    if (rest.length > cap) lines.push(`  … ${rest.length - cap} more — narrow it down with \`filter\`.`);
    if (matching.length === 0) lines.push(`No device matches "${filter}" (${devices.length} total).`);
    return text(lines.join("\n"));
  },
);

tool(
  "select_device",
  "Set the device that later tool calls act on by default. Persists across sessions.",
  { udid: z.string().describe("Device udid, or its exact name.") },
  async ({ udid }) => {
    const { device } = await resolveTarget(udid);
    await patchState({ selected: { udid: device.udid, platform: device.platform, name: device.name } });
    return text(`Selected ${describeDevice(device)}`);
  },
);

tool("boot", "Boot a simulator or emulator and wait until it is ready.", { udid: udidArg }, async ({ udid }) => {
  const devices = await listAll();
  const device = devices.find((d) => d.udid === udid || d.name === udid) ?? (await resolveTarget(udid)).device;
  const backend = backends[device.platform];
  const msg = await backend.boot(device.udid);
  invalidateDeviceCache();
  // Booting an AVD by name produces a device addressed by adb serial — select
  // what is actually running, not the name we were asked to boot.
  const booted = (await listAll(device.platform, true)).filter((d) => d.state === "booted");
  const now = booted.find((d) => d.udid === device.udid || d.name === device.name) ?? booted[0] ?? device;
  await patchState({ selected: { udid: now.udid, platform: now.platform, name: now.name } });
  return text(`${msg}\nSelected ${now.udid} (${now.name}) as the active device.`);
});

tool("shutdown", "Shut down a simulator or emulator.", { udid: udidArg }, async ({ udid }) => {
  const { device, backend } = await resolveTarget(udid);
  const msg = await backend.shutdown(device.udid);
  invalidateDeviceCache();
  return text(msg);
});

tool(
  "screenshot",
  "Capture the current screen and return it as an image. Use this to see what the app is showing.",
  {
    udid: udidArg,
    max_width: z.number().int().min(200).max(2000).optional().describe("Downscale width in px. Default 800."),
    format: z.enum(["jpeg", "png"]).optional().describe("Default jpeg. Use png when you need pixel-exact detail."),
  },
  async ({ udid, max_width, format }) => {
    const { device, backend } = await resolveTarget(udid);
    const path = await screenshotPath(device.udid);
    await backend.screenshot(device.udid, path);
    const image = await encodeScreenshot(path, max_width ?? 800, (format ?? "jpeg") as ImageFormat);
    return {
      content: [
        { type: "image", data: image.base64, mimeType: image.mimeType },
        { type: "text", text: `${device.name} (${device.platform}) — ${image.note}. Full-resolution PNG: ${path}` },
      ],
    };
  },
);

tool(
  "describe_ui",
  "Read the accessibility tree as a flat list of elements with tap coordinates. Cheaper and more reliable than guessing positions from a screenshot.",
  {
    udid: udidArg,
    filter: z.string().optional().describe("Case-insensitive substring match on label, identifier or type."),
    max_elements: z.number().int().min(1).max(500).optional().describe("Default 80."),
  },
  async ({ udid, filter, max_elements }) => {
    const { device, backend } = await resolveTarget(udid);
    let elements = await backend.describeUi(device.udid);
    if (filter) {
      const needle = filter.toLowerCase();
      elements = elements.filter((e) =>
        [e.label, e.identifier, e.type, e.value].some((v) => v?.toLowerCase().includes(needle)),
      );
    }
    if (elements.length === 0) return text(filter ? `No elements match "${filter}".` : "No elements returned.");
    return text(renderElements(elements, max_elements ?? 80));
  },
);

tool(
  "tap",
  "Tap at a coordinate in device points.",
  { udid: udidArg, x: z.number(), y: z.number() },
  async ({ udid, x, y }) => {
    const { device, backend } = await resolveTarget(udid);
    await backend.tap(device.udid, x, y);
    return text(`Tapped (${Math.round(x)}, ${Math.round(y)}) on ${device.name}.`);
  },
);

tool(
  "tap_element",
  "Find an element by its label or accessibility id and tap its centre. Prefer this over raw coordinates — it survives layout changes.",
  {
    udid: udidArg,
    query: z.string().describe("Substring of the element's label or identifier."),
    index: z.number().int().min(0).optional().describe("Which of the ranked matches to tap. Default 0, the best match."),
  },
  async ({ udid, query, index }) => {
    const { device, backend } = await resolveTarget(udid);
    const needle = query.toLowerCase();
    const matches = (await backend.describeUi(device.udid))
      .map((e) => ({ element: e, score: scoreMatch(e, needle) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score);
    if (matches.length === 0) throw new Error(`No element matches "${query}". Call \`describe_ui\` to see what is on screen.`);

    const pick = matches[index ?? 0];
    if (!pick) throw new Error(`Only ${matches.length} matches for "${query}", index ${index} is out of range.`);
    const { element } = pick;
    await backend.tap(device.udid, element.center.x, element.center.y);

    const name = element.label ?? element.identifier ?? element.type;
    const lines = [`Tapped ${element.type} "${name}" at (${element.center.x}, ${element.center.y}).`];
    if (matches.length > 1) {
      lines.push(
        `${matches.length} matched; pass index to pick another:`,
        ...matches.slice(0, 5).map((m, i) => `  ${i}: ${m.element.type} "${m.element.label ?? m.element.identifier}"`),
      );
    }
    return text(lines.join("\n"));
  },
);

tool(
  "swipe",
  "Swipe or drag from one coordinate to another.",
  {
    udid: udidArg,
    x1: z.number(),
    y1: z.number(),
    x2: z.number(),
    y2: z.number(),
    duration_ms: z.number().int().min(50).max(10_000).optional().describe("Default 300."),
  },
  async ({ udid, x1, y1, x2, y2, duration_ms }) => {
    const { device, backend } = await resolveTarget(udid);
    await backend.swipe(device.udid, x1, y1, x2, y2, duration_ms ?? 300);
    return text(`Swiped (${x1}, ${y1}) → (${x2}, ${y2}) on ${device.name}.`);
  },
);

tool(
  "type_text",
  "Type text into the focused field. Tap the field first.",
  { udid: udidArg, text: z.string() },
  async ({ udid, text: value }) => {
    const { device, backend } = await resolveTarget(udid);
    await backend.typeText(device.udid, value);
    return text(`Typed ${value.length} characters.`);
  },
);

tool(
  "press_button",
  "Press a hardware button.",
  {
    udid: udidArg,
    button: z.enum(["home", "lock", "back", "power", "volume_up", "volume_down", "siri", "app_switch"]),
  },
  async ({ udid, button }) => {
    const { device, backend } = await resolveTarget(udid);
    await backend.pressButton(device.udid, button as ButtonName);
    return text(`Pressed ${button} on ${device.name}.`);
  },
);

tool(
  "install_app",
  "Install a built app: a .app bundle on iOS, an .apk on Android.",
  { udid: udidArg, path: z.string().describe("Absolute path to the .app or .apk.") },
  async ({ udid, path }) => {
    const { device, backend } = await resolveTarget(udid);
    return text(await backend.installApp(device.udid, path));
  },
);

tool(
  "launch_app",
  "Launch an installed app by bundle id (iOS) or package name (Android).",
  {
    udid: udidArg,
    bundle_id: z.string(),
    force_restart: z.boolean().optional().describe("Terminate first if already running. Default false."),
  },
  async ({ udid, bundle_id, force_restart }) => {
    const { device, backend } = await resolveTarget(udid);
    return text(await backend.launchApp(device.udid, bundle_id, force_restart ?? false));
  },
);

tool(
  "open_url",
  "Open a URL or deep link on the device.",
  { udid: udidArg, url: z.string() },
  async ({ udid, url }) => {
    const { device, backend } = await resolveTarget(udid);
    await backend.openUrl(device.udid, url);
    return text(`Opened ${url} on ${device.name}.`);
  },
);

tool(
  "record_start",
  "Start recording the screen to an MP4. Note: the agent cannot watch the video — it is a file for the user. Use screenshots to verify state.",
  { udid: udidArg, path: z.string().optional().describe("Output path. Defaults to ~/Desktop/canvas-recording-<ts>.mp4.") },
  async ({ udid, path }) => {
    const existing = (await readState()).recording;
    if (existing && isAlive(existing.pid)) {
      throw new Error(`A recording is already running (${existing.outputPath}). Call \`record_stop\` first.`);
    }
    const { device, backend } = await resolveTarget(udid);
    const outPath = path ?? (await defaultRecordingPath());
    const recording = await backend.recordStart(device.udid, outPath);
    await patchState({ recording });
    return text(`Recording ${device.name} → ${outPath}\nAndroid caps a single recording at 180 seconds.`);
  },
);

tool("record_stop", "Stop the running recording and return the finished file path.", {}, async () => {
  const recording = (await readState()).recording;
  if (!recording) throw new Error("No recording is running.");
  const backend = backends[recording.platform];
  const finished = await backend.recordStop(recording);
  await patchState({ recording: undefined });
  const seconds = Math.round((Date.now() - new Date(recording.startedAt).getTime()) / 1000);
  return text(`Stopped after ~${seconds}s. Video: ${finished}`);
});

tool(
  "logs",
  "Read recent device logs (iOS: last 3 minutes of the unified log; Android: logcat).",
  {
    udid: udidArg,
    lines: z.number().int().min(1).max(1000).optional().describe("Default 100."),
    filter: z.string().optional().describe("Case-insensitive substring filter."),
  },
  async ({ udid, lines, filter }) => {
    const { device, backend } = await resolveTarget(udid);
    const out = await backend.logs(device.udid, lines ?? 100, filter);
    return text(out || "No matching log lines.");
  },
);

/* ------------------------------------------------------------------- start */

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  log(`canvas ${VERSION} ready (idb: ${(await hasIdb()) ? "yes" : "no"}, adb: ${(await has("adb")) ? "yes" : "no"})`);
}

main().catch((e: unknown) => {
  log("fatal:", e);
  process.exit(1);
});
