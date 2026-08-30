import type { Platform, Recording } from "./state.js";

export interface Device {
  udid: string;
  name: string;
  platform: Platform;
  state: "booted" | "shutdown" | "unknown";
  os?: string;
}

/** One flattened, tappable element. Coordinates are in device points. */
export interface UiElement {
  type: string;
  label?: string;
  identifier?: string;
  value?: string;
  enabled?: boolean;
  frame: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
}

export type ButtonName = "home" | "lock" | "back" | "power" | "volume_up" | "volume_down" | "siri" | "app_switch";

export interface Backend {
  readonly platform: Platform;
  list(): Promise<Device[]>;
  boot(udid: string): Promise<string>;
  shutdown(udid: string): Promise<string>;
  screenshot(udid: string, outPath: string): Promise<void>;
  describeUi(udid: string): Promise<UiElement[]>;
  tap(udid: string, x: number, y: number): Promise<void>;
  swipe(udid: string, x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
  typeText(udid: string, text: string): Promise<void>;
  pressButton(udid: string, button: ButtonName): Promise<void>;
  installApp(udid: string, appPath: string): Promise<string>;
  launchApp(udid: string, bundleId: string, forceRestart: boolean): Promise<string>;
  openUrl(udid: string, url: string): Promise<void>;
  recordStart(udid: string, outPath: string): Promise<Recording>;
  recordStop(recording: Recording): Promise<string>;
  logs(udid: string, lines: number, filter?: string): Promise<string>;
}

export function center(frame: UiElement["frame"]): UiElement["center"] {
  return { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) };
}
