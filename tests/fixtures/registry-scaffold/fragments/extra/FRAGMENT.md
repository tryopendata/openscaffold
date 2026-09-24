---
schema_version: 1
id: extra
kind: fragment
name: Extra tooling
description: Adds a remote runner.
category: tooling
requires: [agent-ops]
requires_tools: [frobnicate]
merge: [.claude/settings.json]
decisions:
  - "Remote host (default: none)"
env:
  PORT_RR: "9000"
verify:
  - { name: extra-check, run: "true" }
---

## What to add

A remote runner hook.
