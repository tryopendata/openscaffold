---
description: Add an Effect service (Tag + Live layer) and wire it into the runtime
argument-hint: "<service name and responsibility>"
---

Add a service: $ARGUMENTS

Follow `.claude/rules/app/effect-server.md`, and look at an existing service in `app/.server/services/` first.

1. **Interface.** A `Context.Tag` in `app/.server/services/<Name>.ts` with a small interface of Effect-returning methods. Failures it can produce are tagged errors in `errors.ts`, each mapped to an HTTP status in `runRoute`.
2. **Live layer.** Reads its settings from Config (add new env vars to `config.ts` and `.env.example`). If it keeps in-memory state, keep that state on `globalThis` in dev so hot reload doesn't reset it.
3. **Wire it** into `AppLayer` and the `AppServices` union in `runtime.ts` (re-export the Tag there too), and into `makeTestLayer` in `tests/helpers/runtime.ts` (a `*Memory` layer with fresh state if it keeps state). Missing either one shows up as a `ManagedRuntime` type error in route tests.
4. **Tests.** Test it with `@effect/vitest` using its real Live layer where that's in-memory, or pointed at a local stub server where it calls a third party. Use `TestClock` for anything time-based.
5. `/check`.

Keep the interface free of implementation details, so a different backing store later is a new layer, not a new interface.
