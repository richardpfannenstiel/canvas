---
description: Walk a UI flow on the simulator and report what happened
argument-hint: "what to test, e.g. the signup flow on iOS"
disable-model-invocation: false
---

Test this flow on the simulator: $ARGUMENTS

Delegate to the `mobile-tester` agent so the screenshots stay out of this
conversation, then relay its verdict, the problems it found, and anything it
could not reach.

If no device is booted, boot one first and say which you picked. If the flow
needs a specific app that is not installed, stop and ask for the build path
rather than guessing.
