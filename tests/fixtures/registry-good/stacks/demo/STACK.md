---
schema_version: 1
id: demo
kind: stack
name: Demo web app
description: A tiny web app used to test validation.
tags: [typescript, web]
tools: [bun]
fragments:
  default: [base]
  optional: [extra]
env:
  PORT_WEB: "3000"
decisions:
  - "Project name (default: the directory name)"
verify:
  - { name: install, phase: setup, run: bun install }
  - { name: test, run: bun test }
---

## Layout

One package at the root.
