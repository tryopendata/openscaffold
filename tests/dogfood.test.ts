import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// This repo runs the agent-ops fragment's Claude adapter on itself. The copies must track the
// registry, so a hook fixed in one place is fixed in both.
const ROOT = resolve(import.meta.dirname, "..");
const ADAPTER = join(ROOT, "registry/fragments/agent-ops/adapters/claude");

describe("dogfooded agent-ops adapter", () => {
  it("keeps .claude/hooks identical to the fragment's hooks", () => {
    for (const name of readdirSync(join(ADAPTER, ".claude/hooks"))) {
      const shipped = readFileSync(join(ADAPTER, ".claude/hooks", name), "utf8");
      const local = readFileSync(join(ROOT, ".claude/hooks", name), "utf8");
      expect(local, `.claude/hooks/${name} drifted; copy it from ${ADAPTER}`).toBe(shipped);
    }
  });

  it("keeps CLAUDE.md identical to the fragment's", () => {
    expect(readFileSync(join(ROOT, "CLAUDE.md"), "utf8")).toBe(
      readFileSync(join(ADAPTER, "CLAUDE.md"), "utf8"),
    );
  });
});
