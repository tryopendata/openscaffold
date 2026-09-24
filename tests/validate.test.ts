import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isVersionSensitive, validatePath } from "../src/commands/validate.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
let emptyBundled: string;

beforeAll(() => {
  emptyBundled = mkdtempSync(join(tmpdir(), "os-validate-"));
  mkdirSync(join(emptyBundled, "fragments"));
});
afterAll(() => rmSync(emptyBundled, { recursive: true, force: true }));

const validate = (path: string, bundledDir = emptyBundled) => validatePath(path, { bundledDir });

describe("validate", () => {
  it("passes a good registry", () => {
    const report = validate(join(FIXTURES, "registry-good"));
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report).toMatchObject({ ok: true, stacks: 1, fragments: 2 });
  });

  it("validates a single entry directory, resolving references against bundled", () => {
    const extra = join(FIXTURES, "registry-good", "fragments", "extra");
    const alone = validate(extra);
    expect(alone.ok).toBe(false);
    expect(alone.errors).toEqual([
      { file: "FRAGMENT.md", message: 'requires references unknown fragment "base"' },
    ]);
    const withBundled = validate(extra, join(FIXTURES, "registry-good"));
    expect(withBundled.ok).toBe(true);
  });

  it("reports malformed conditional blocks in entry bodies", () => {
    const root = mkdtempSync(join(tmpdir(), "os-validate-cond-"));
    try {
      cpSync(join(FIXTURES, "registry-good"), root, { recursive: true });
      const file = join(root, "fragments", "extra", "FRAGMENT.md");
      writeFileSync(
        file,
        `${readFileSync(file, "utf8")}\n<!-- openscaffold:when color=blue -->\nhidden\n`,
      );
      const report = validate(root);
      const messages = report.errors
        .filter((e) => e.file === "fragments/extra/FRAGMENT.md")
        .map((e) => e.message);
      expect(report.ok).toBe(false);
      expect(messages.some((m) => m.startsWith("conditional block:"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("bad registry", () => {
    const report = validatePath(join(FIXTURES, "registry-bad"), {
      bundledDir: join(FIXTURES, "registry-good"),
    });
    const errorFor = (file: string) =>
      report.errors
        .filter((e) => e.file === file)
        .map((e) => e.message)
        .join("\n");

    it("fails", () => expect(report.ok).toBe(false));

    it("reports schema errors with field paths", () => {
      const msg = errorFor("fragments/bad-schema/FRAGMENT.md");
      expect(msg).toContain("category");
      expect(msg).toContain("bogus_field");
    });

    it("reports newer schema_version, id mismatch, and missing FRAGMENT.md", () => {
      expect(errorFor("fragments/future/FRAGMENT.md")).toContain("schema_version 2");
      expect(errorFor("fragments/wrong-name/FRAGMENT.md")).toContain('"other-name"');
      expect(errorFor("fragments/no-file/FRAGMENT.md")).toContain("missing");
    });

    it("reports stack/fragment id collisions", () => {
      expect(errorFor("stacks/shared-id/STACK.md")).toContain("both a stack and a fragment");
    });

    it("reports unresolved references", () => {
      expect(errorFor("stacks/broken/STACK.md")).toContain(
        'fragments.default references unknown fragment "missing-frag"',
      );
    });

    it("reports unknown template variables and invalid merge JSON", () => {
      expect(errorFor("fragments/bad-tmpl/files/README.md.tmpl")).toContain("{{unknown_var}}");
      expect(errorFor("fragments/bad-json/adapters/claude/.claude/settings.json")).toContain(
        "valid JSON",
      );
    });

    it("catches ownership collisions in the composition dry run", () => {
      expect(errorFor("stacks/collide/STACK.md")).toContain(
        "same.txt is written by more than one entry (dup-a, dup-b)",
      );
    });

    it("warns about version-sensitive files", () => {
      expect(report.warnings.map((w) => w.file).sort()).toEqual([
        "fragments/versiony/files/.github/workflows/ci.yml",
        "fragments/versiony/files/tsconfig.json",
      ]);
    });
  });

  it("dry-runs each optional fragment against the stack", () => {
    const root = join(emptyBundled, "optional-clash");
    cpSync(join(FIXTURES, "registry-good"), root, { recursive: true });
    const stackFile = join(root, "stacks", "demo", "STACK.md");
    writeFileSync(
      stackFile,
      readFileSync(stackFile, "utf8").replace("optional: [extra]", "optional: [extra, clash]"),
    );
    mkdirSync(join(root, "fragments", "clash"));
    writeFileSync(
      join(root, "fragments", "clash", "FRAGMENT.md"),
      "---\nschema_version: 1\nid: clash\nkind: fragment\nname: Clash\ndescription: d\ncategory: tooling\nverify:\n  - { name: test, run: make test }\n---\n",
    );
    const report = validate(root);
    expect(report.errors).toEqual([
      {
        file: "stacks/demo/STACK.md",
        message: 'composing demo with clash: verify step "test" is defined by both demo and clash',
      },
    ]);
  });

  it("reports symlinks in files/ as errors", () => {
    const root = join(emptyBundled, "with-symlink");
    cpSync(join(FIXTURES, "registry-good"), root, { recursive: true });
    symlinkSync("/etc/hosts", join(root, "fragments", "base", "files", "hosts"));
    symlinkSync("..", join(root, "fragments", "base", "files", "loop"));
    const report = validate(root);
    expect(report.ok).toBe(false);
    const files = report.errors.map((e) => e.file);
    expect(files).toContain("fragments/base/files/hosts");
    expect(files).toContain("fragments/base/files/loop");
    expect(report.errors.find((e) => e.file === "fragments/base/files/hosts")?.message).toMatch(
      /symlink/,
    );
  });

  it("accepts mergeable JSON templates with placeholders outside quotes", () => {
    const root = join(emptyBundled, "unquoted");
    cpSync(join(FIXTURES, "registry-good"), root, { recursive: true });
    const settings = join(root, "fragments", "base", "adapters", "claude", ".claude");
    rmSync(settings, { recursive: true, force: true });
    mkdirSync(settings, { recursive: true });
    writeFileSync(
      join(settings, "settings.json.tmpl"),
      '{"since": {{year}}, "name": "{{project_name}}"}',
    );
    const report = validate(root);
    expect(report.errors).toEqual([]);
  });

  it("rejects a path that isn't a registry or entry", () => {
    expect(() => validate(join(emptyBundled, "nope"))).toThrow(/not a directory/);
    expect(() => validate(tmpdir())).toThrow(/no STACK.md, FRAGMENT.md, stacks\/, or fragments\//);
  });

  it("recognizes version-sensitive filenames", () => {
    for (const f of [
      ".golangci.yml",
      "backend/pyproject.toml",
      "tsconfig.node.json",
      "Dockerfile.dev",
      ".github/workflows/release.yaml",
      "compose.yaml",
      "docker-compose.dev.yml",
      "biome.json",
    ]) {
      expect(isVersionSensitive(f), f).toBe(true);
    }
    for (const f of ["AGENTS.md", ".editorconfig", "lefthook.yml", ".claude/settings.json"]) {
      expect(isVersionSensitive(f), f).toBe(false);
    }
  });
});
