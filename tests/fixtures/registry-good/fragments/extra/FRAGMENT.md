---
schema_version: 1
id: extra
kind: fragment
name: Extra tooling
description: Adds a remote runner hook to Claude settings.
category: tooling
requires: [base]
merge: [.claude/settings.json]
verify:
  - { name: extra-check, run: "true" }
---

## What to add

A hook.
