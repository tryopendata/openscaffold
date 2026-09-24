---
schema_version: 1
id: postgres
kind: fragment
name: postgres
description: Fixture entry.
category: service
requires_tools: [docker]
env:
  PORT_DB: "5432"
  PORT_WEB: "3000"
verify:
  - { name: db-up, phase: setup, run: docker compose up -d }
---

Guidance for postgres.
