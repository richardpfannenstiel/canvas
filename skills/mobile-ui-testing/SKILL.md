---
name: mobile-ui-testing
description: This skill should be used when driving an iOS Simulator or Android emulator through the canvas MCP tools — walking a UI flow, reproducing a bug on device, verifying a screen after a code change, capturing a screenshot or screen recording, or checking that a build installs and launches. Covers the read-act-verify loop, coordinate handling, and the platform differences between simctl/idb and adb.
version: 0.1.0
---

# Driving a simulator with canvas

## The loop

Never tap coordinates read off a screenshot. Screenshots are downscaled and the
coordinate frames differ; `describe_ui` returns real device points.

1. `describe_ui` — see what is on screen and where.
2. `tap_element` with a label substring — survives layout changes, unlike raw
   coordinates. It ranks matches (exact label over partial, real control over
   layout wrapper) and lists the alternatives it did not take; if it picked the
   wrong one, repeat the call with `index` rather than switching to raw
   coordinates.
3. `screenshot` — verify the result, then repeat.

Fall back to `tap` with explicit coordinates only for canvas/game surfaces and
custom-drawn views that expose no accessibility elements. On Android,
`describe_ui` also hides pure layout scaffolding, so an element with no label,
no resource id and no clickable flag will not appear.

## Getting started in a session

Run `doctor` first when anything behaves oddly — it reports which binaries are
present and what each missing one costs you. `boot` selects the device it
booted, so a single `boot` call is usually all the setup needed. With several
devices running, pin one with `select_device`; the selection persists across
sessions in `~/.canvas-mcp/state.json`.

## What each platform can do

| | iOS | Android |
|---|---|---|
| Lifecycle, install, launch, screenshot, video, logs | `simctl` — always available with Xcode | `adb` |
| Tap, swipe, type, buttons, UI tree | **requires `idb`** | `adb` |

So on a machine without `idb`, everything except input and `describe_ui` still
works. If an input tool returns an install hint, relay it rather than trying to
work around it.

## Typing

`type_text` goes to whatever field currently has focus — tap the field first.
It does not clear existing content; select-all and delete first if the field is
not empty.

## Screenshots and video

`screenshot` returns a downscaled JPEG for reading plus the path to a
full-resolution PNG. Pass `format: "png"` only when pixel-exact detail matters.

`record_start` / `record_stop` write an MP4 **for the human** — the agent
cannot watch it. To verify a flow yourself, take screenshots at each step.

Two recording caveats worth stating to the user up front:

- On iOS, `simctl` captures frames only when the screen changes. Recording a
  static screen yields a video a few frames long. That is not a bug.
- On Android, a single `screenrecord` run stops after 180 seconds.

## Waiting

None of the input tools wait for the UI to settle. After an action that starts
a navigation or a network call, take a screenshot, and if the screen is still
mid-transition, take another rather than tapping into an animation.

## Reporting

When a flow fails, report the step that failed, the screenshot at that point,
and the relevant `logs` output — not just "it did not work".
