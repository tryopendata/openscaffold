---
schema_version: 1
id: deploy
kind: fragment
name: Deploy
description: Deploy target.
category: deploy
verify:
  - { name: deploy-check, run: "true", tags: [prod] }
---

## What to add

A deploy config.
