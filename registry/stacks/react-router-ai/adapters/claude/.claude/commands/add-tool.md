---
description: Add an AI SDK tool the chat model can call, with its schema and tests
argument-hint: "<what the tool does>"
---

Add a tool: $ARGUMENTS

Follow `.claude/rules/app/ai-sdk.md`. Look at the existing example tool in `app/.server/tools/` first and match its shape.

1. **Schema** in `app/schemas/tools.ts`: the input and output as Effect Schemas with `title`/`description` annotations on the schema and its fields (the model reads these to decide when and how to call the tool). No `identifier` annotation, and give any custom `Schema.filter` a `jsonSchema` annotation (see the `TimeZone` schema).
2. **Tool** next to `currentTime` in `app/.server/tools/index.ts` (or its own file there): `tool({ description, inputSchema: toAiSchema(Input), execute })`. `toAiSchema` already does the JSON Schema and decoder-backed validation; don't hand-roll it. Dependencies come in through `ToolDeps` (built in `chat.ts` from the Effect runtime), not by importing a Live layer.
3. **Register** it in `makeTools` so `streamText` sees it.
4. **Client type**: add `<name>: { input; output }` to `ChatTools` in `app/lib/chat.ts`. It's hand-kept; without it the tool's parts are untyped in the UI.
5. **Render** its part in `MessageParts` in `app/components/chat/message-list.tsx` (a `part.type === "tool-<name>"` branch covering the input, output, and error states). Unknown part types render nothing, so a missing branch means the tool is invisible.
6. **Prompt**: if the model should prefer the tool over guessing, add a line to `DEFAULT_SYSTEM_PROMPT` in `app/.server/prompts.ts`.
7. **Tests.** Unit-test `execute` for valid input, invalid input, and any failure it can hit (`tests/tools.test.ts`). Then add a closed-loop case (`tests/chat-closed-loop.test.tsx`) where the mock model calls the new tool (`toolCallReply` in `tests/helpers/mock-model.ts`) and assert its rendered result reaches the DOM.
8. `/check`.

If the tool calls a third-party API, add its base URL to Config and point tests at a local stub server. Tests never hit the network.
