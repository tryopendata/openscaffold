---
schema_version: 1
id: app
kind: stack
name: Fixture App
description: A small web app fixture.
tags: [typescript, web]
deps:
  app: [react]
  dev: [vitest]
tools: [bun]
fragments:
  default: [agent-ops, deploy]
  optional: [extra]
env:
  PORT_WEB: "3000"
decisions:
  - "Project name (default: the directory name)"
verify:
  - { name: install, phase: setup, run: bun install }
  - { name: test, run: bun test }
  - { name: build, run: bun run build, tags: [prod] }
  - name: web
    phase: serve
    run: bun run dev
    expect: { http: "http://localhost:${PORT_WEB}/", within: 30s }
---

# Fixture App

## Layout

One package at the root.

```
# not a heading
```
