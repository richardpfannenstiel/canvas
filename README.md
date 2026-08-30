# canvas

Agent-driven control of local **iOS Simulators** and **Android emulators**:
boot devices, read the accessibility tree, tap/swipe/type, capture screenshots
and record video — from Claude Code, GitHub Copilot CLI, or VS Code.

Distributed as a plugin for Claude Code, GitHub Copilot CLI, and VS Code. The
functionality lives in a bundled stdio MCP server (`dist/canvas.mjs`), which
the host spawns as a child process; there is no daemon, no port, and nothing
leaves the machine.

## Install

```
/plugin marketplace add <your-github-user>/canvas
/plugin install canvas@canvas
```

Then run the `doctor` tool (or `/canvas-doctor`) to check the tooling.

The root `plugin.json` is the manifest used by GitHub Copilot and VS Code. The
equivalent `.claude-plugin/plugin.json` manifest keeps Claude Code support
working. Both manifests point to the same `.mcp.json` server definition.

## Requirements

| | Needed for | Install |
|---|---|---|
| **Xcode** | all iOS support | App Store, then `xcode-select --install` |
| **idb** | iOS tap / swipe / type / UI tree | `brew tap facebook/fb && brew install idb-companion` + `pipx install fb-idb` |
| **adb** + `emulator` | all Android support | Android Studio → SDK platform-tools |
| **ffmpeg** | smaller screenshots (falls back to `sips`) | `brew install ffmpeg` |

`idb` needs Homebrew's trust step for Meta's tap:
`brew trust --formula facebook/fb/idb-companion`.

Tools do not have to be on `PATH`. The server is spawned by the editor rather
than a login shell, so it also looks in `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`,
`~/Library/Android/sdk`, `~/.local/bin` and the Homebrew prefixes. Override any
lookup with `CANVAS_ADB_PATH`, `CANVAS_IDB_PATH`, `CANVAS_EMULATOR_PATH`, etc.

Nothing is required beyond Xcode to boot devices, install and launch apps, take
screenshots, record video and read logs. `idb` adds the input and inspection
half on iOS; on Android `adb` covers everything on its own.

## Tools

| Tool | |
|---|---|
| `doctor` | what is installed, what each missing piece costs |
| `list_devices` · `select_device` | discovery and a persistent default device |
| `boot` · `shutdown` | lifecycle, waits for the device to be ready |
| `install_app` · `launch_app` · `open_url` | get a build onto the device and running |
| `screenshot` | downscaled JPEG for the agent + full-res PNG on disk |
| `describe_ui` | flat element list with tap coordinates |
| `tap` · `tap_element` · `swipe` · `type_text` · `press_button` | input; `tap_element` ranks matches and reports the alternatives |
| `record_start` · `record_stop` | MP4 for the human — the agent cannot watch it |
| `logs` | unified log (iOS) / logcat (Android) |

Plus a `mobile-ui-testing` skill, a `mobile-tester` subagent for long flows,
and the `/canvas-doctor` and `/canvas-flow` commands.

## Development

```bash
npm install
npm run build        # bundles src/ -> dist/canvas.mjs (committed; it is what ships)
npm run typecheck
npm run dev          # build + MCP Inspector, to exercise tools without an agent
```

Run the plugin from a working copy instead of the marketplace:

```bash
claude --plugin-dir /path/to/canvas
```

Two things to keep in mind when editing the server:

- **stdout belongs to the JSON-RPC channel.** Log to stderr only; a stray
  `console.log` makes the host drop the server.
- The server is not hot-reloaded. Rebuild, then restart the session.

## Verified

End-to-end against an iPhone 16e (iOS 26.1, via idb 1.1.x) and a Pixel_4 AVD
(Android 13): boot from cold, install-free app launch, accessibility tree, tap
by label, text entry, swipe, hardware buttons, screenshot, MP4 recording and
logs. `install_app` is the one tool exercised only through its error paths — no
build was on hand to install.

## Known limits

- iOS video: `simctl` records frames only on screen changes, so a recording of
  a static screen is a few frames long.
- Android video: `screenrecord` stops after 180 seconds per file.
- `logs` on iOS reads the last 2 minutes of the unified log and takes a few
  seconds; it is not a live stream.
- Physical devices are out of scope — simulators and emulators only.
- `describe_ui` on Android drops pure layout scaffolding. If an element you
  expect is missing, it had no label, no id and was not clickable — fall back
  to `tap` with coordinates read from `screenshot`.

## License

MIT
