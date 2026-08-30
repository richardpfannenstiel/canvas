import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { has, requireBin, run } from "./util.js";

export type ImageFormat = "jpeg" | "png";

export interface ImagePayload {
  base64: string;
  mimeType: string;
  bytes: number;
  note: string;
}

/**
 * A raw simulator screenshot is a 1179x2556 PNG of ~4 MB — roughly 5 MB once
 * base64-encoded into the transcript. Over a 20-step UI loop that alone
 * dominates the session. Downscaling to ~800px wide and encoding as JPEG puts
 * a legible frame in front of the agent for ~150 KB. The untouched PNG stays
 * on disk, so nothing is lost for the human looking at it later.
 */
export async function encodeScreenshot(path: string, maxWidth: number, format: ImageFormat = "jpeg"): Promise<ImagePayload> {
  const original = await stat(path);
  const ext = format === "jpeg" ? "jpg" : "png";
  const resized = join(tmpdir(), `canvas-scaled-${Date.now()}.${ext}`);
  let source = path;
  let via = "unscaled";

  if (await has("ffmpeg")) {
    const args = ["-y", "-loglevel", "error", "-i", path, "-vf", `scale='min(${maxWidth},iw)':-2:flags=lanczos`];
    if (format === "jpeg") args.push("-q:v", "4");
    args.push(resized);
    if ((await run(await requireBin("ffmpeg"), args, { timeoutMs: 30_000 })).code === 0) {
      source = resized;
      via = "ffmpeg";
    }
  } else if (await has("sips")) {
    const args = ["-Z", String(maxWidth * 3)];
    if (format === "jpeg") args.push("-s", "format", "jpeg");
    args.push(path, "--out", resized);
    if ((await run(await requireBin("sips"), args, { timeoutMs: 30_000 })).code === 0) {
      source = resized;
      via = "sips";
    }
  }

  const buf = await readFile(source);
  if (source !== path) await rm(resized, { force: true }).catch(() => {});
  const kb = (n: number): string => `${Math.round(n / 1024)} KB`;
  return {
    base64: buf.toString("base64"),
    mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
    bytes: buf.length,
    note: via === "unscaled"
      ? `${kb(buf.length)} unscaled — install ffmpeg to shrink screenshots`
      : `${kb(buf.length)} (from ${kb(original.size)})`,
  };
}
