---
schema_version: 1
id: agent-ops
kind: fragment
name: Agent ops
description: AGENTS.md and Claude settings.
category: agent-ops
merge: [.claude/settings.json]
verify:
  - { name: agents-md, run: test -s AGENTS.md }
---

## What to add

Fill in AGENTS.md.
