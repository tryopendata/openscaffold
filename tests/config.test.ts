import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadUserConfig } from "../src/config.js";
import { OpenScaffoldError } from "../src/errors.js";

let home: string;
const writeConfig = (text: string) => {
  mkdirSync(join(home, ".openscaffold"), { recursive: true });
  writeFileSync(join(home, ".openscaffold", "config.yaml"), text);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "os-config-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("loadUserConfig", () => {
  it("returns defaults when the file is missing or empty", () => {
    const defaults = { always: [], agents: [], preset: "default" };
    expect(loadUserConfig(home)).toEqual(defaults);
    writeConfig("");
    expect(loadUserConfig(home)).toEqual(defaults);
  });

  it("reads every supported key from config.yaml", () => {
    writeConfig(
      "always: [rr, ce-plugin]\nagents: [claude, codex]\nauthor: Riley\npreset: sandbox\n",
    );
    expect(loadUserConfig(home)).toMatchObject({
      always: ["rr", "ce-plugin"],
      agents: ["claude", "codex"],
      author: "Riley",
      preset: "sandbox",
    });
  });

  it("reports schema problems with field paths and a hint", () => {
    writeConfig("agents: [claude, vim]\nalways_typo: []\n");
    try {
      loadUserConfig(home);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OpenScaffoldError);
      const e = err as OpenScaffoldError;
      expect(e.message).toContain("agents.1");
      expect(e.message).toContain("always_typo");
      expect(e.hint).toContain("Valid keys");
    }
  });

  it("reports YAML syntax errors", () => {
    writeConfig("always: [rr\n");
    expect(() => loadUserConfig(home)).toThrow(/not valid YAML/);
  });
});
