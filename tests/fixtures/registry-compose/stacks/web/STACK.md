---
schema_version: 1
id: web
kind: stack
name: web
description: Fixture entry.
tags: [typescript, web]
tools: [bun]
fragments:
  default: [agent-ops, ci, fly]
  optional: [postgres]
env:
  PORT_WEB: "3000"
decisions:
  - "Project name (default: the directory name)"
verify:
  - { name: install, phase: setup, run: bun install }
  - { name: test, run: bun test }
---

Guidance for web.
