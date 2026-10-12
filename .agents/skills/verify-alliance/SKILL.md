---
name: verify-alliance
description: Verify Alliance Work changes against native skill discovery, candidate evidence and release activation. Use when a change affects those paths; choose the checks for the affected boundary.
---

# Verify Alliance Work

Read [the feature map](references/features.md) for the behavior changed. Use a disposable
home, checkout and loopback port for native checks; the maintenance suite provisions these.
Never point tests at an operator's running instance. Node 24 and the participating native
harness binaries must be on PATH. `npm run check` and `npm run lint` are contributor gates.

Record a selected check with `alliance-work verify --scenario NAME --kind test -- npm run check`,
or use the CLI from this checkout. Use `runtime` for the native scenario being exercised;
the report establishes only that boundary. Native discovery creates no model turn. A real
model delegation/handback still needs a separate authorized exercise and usable credentials.

Feature steps and selectors must be updated when a changed path invalidates them. If a
native binary, credential or environment is unavailable, state the blocked scenario and
the narrower checks that ran. Do not turn a skipped native test into product acceptance.
