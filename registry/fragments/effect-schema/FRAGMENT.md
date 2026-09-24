---
schema_version: 1
id: effect-schema
kind: fragment
category: tooling
name: Effect Schema
description: Effect Schema as the one validation and typing layer for data crossing a trust boundary (requests, config, storage, third-party and LLM output), with branded ids, tagged errors, JSON Schema for tools, and round-trip plus property tests.
tags: [typescript, effect, validation, schema]
applies_to: [typescript]
deps:
  typescript: [effect]
decisions:
  - "Schema location: one directory both client and server code can import (default), for example `app/schemas/` or `src/schemas/`, or the shared package in a monorepo."
  - "Existing validators: keep them and use Effect Schema at new boundaries (default), or migrate one boundary at a time when touched."
---

# Effect Schema

One schema per shape of data that crosses a trust boundary, used to decode on the way in and encode on the way out. The schema is the source of the TypeScript type, never the other way round.

## What to add

Install `effect` (Schema is part of it). Never install the standalone `@effect/schema` package: it was folded into `effect`, and older examples that import from it are out of date.

**Where schemas live.** One file per domain in the schema directory from Decisions, re-exported from an `index.ts`. Schemas import only `effect`, so both client and server code can use them.

<!-- openscaffold:when stack=react-router-ai -->
For this stack that's `app/schemas/`. Loaders and actions decode their input (params, form data, JSON bodies) with these schemas, and message metadata (usage, cost, interrupted) has its own schema that client and server share.
<!-- openscaffold:end -->

**Conventions.**
- A schema and its type share a name: `export const User = Schema.Struct({...})` and `export type User = typeof User.Type`. Use the encoded type (`typeof User.Encoded`) where the wire form differs.
- `Schema.Class` for entities with identity or behavior, `Schema.Struct` for plain DTOs and request/response bodies.
- Brand ids (`UserId`, `ChatId`) so they can't be swapped with each other or with plain strings.
- Decode at every trust boundary: request input, env and config, rows read from storage, third-party API responses, and structured output from an LLM. Code past the boundary works with decoded types and doesn't re-validate. Encode when writing to the wire or to storage.
- Filters check a value (`Schema.filter`, the built-in length/pattern checks), and transformations change its representation (a date string to a `Date`). Don't hide conversion inside a filter.
- Annotate schemas that leave the process (`title`, `description`, examples). `JSONSchema.make` turns them into JSON Schema, which is how a schema reaches a library that needs JSON Schema, such as LLM tool definitions or structured output. Decode the library's result with the same schema afterwards. Don't put an `identifier` on a schema meant for an LLM: `JSONSchema.make` turns identified schemas into `$ref` plus `$defs`, which tool and structured-output APIs handle poorly.
- Libraries that only validate and accept Standard Schema get the schema through Effect's Standard Schema adapter.
- Domain errors are `Schema.TaggedError` classes, so they are typed, serializable, and matchable by tag.
- Zod only where a library accepts nothing else, kept at that library's edge. A dependency pulling in zod as its own peer is fine.
- Validators owned by a framework or code generator stay as they are (Astro content collections use `astro/zod`, orval generates zod). Effect Schema covers the boundaries the project owns.

<!-- openscaffold:when mode=add -->
**Adding to an existing project.** Leave existing validators in place. Use Effect Schema for new boundaries, and convert an old one only when you're already changing it, with its tests passing before and after.
<!-- openscaffold:end -->

## Testing

- A decode/encode round trip for each schema with a transformation: `encode(decode(x))` equals `x` for valid input.
- Invalid input fails with a readable message: test the cases that matter (missing field, wrong brand, out-of-range value), not every field.
- Property tests for non-trivial schemas: generate values with Effect's `Arbitrary` from the schema and check the round trip holds for all of them.

## Gotchas

- Schema's API names shift between Effect majors (filters, class constructors, the Standard Schema and JSON Schema helpers). Check the installed version's docs or type definitions for the current names rather than relying on memory.
- `JSONSchema.make` can't express every schema. Transformations and custom filters without a JSON Schema annotation are dropped or rejected, so give such schemas an explicit JSON Schema annotation or keep tool and output schemas plain. A filter's JSON Schema annotation replaces the generated schema for that node entirely, so put its description and examples inside the annotation.

## AGENTS.md

A **Schemas** section: where schemas live, decode-at-the-boundary, the name-sharing rule, branded ids, tagged errors, how a schema becomes JSON Schema for tools, and that framework- or generator-owned validators are left alone.
