import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpenScaffoldError } from "../src/errors.js";
import { hashVerify, MANIFEST_PATH, readManifest, writeManifest } from "../src/manifest.js";
import type { Manifest, VerifyStep } from "../src/schema/index.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "os-manifest-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const steps: VerifyStep[] = [
  { name: "lint", run: "make lint", phase: "check", tags: [] },
  {
    name: "api",
    run: "make dev",
    phase: "serve",
    tags: [],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${VAR} is verify env syntax
    expect: { http: "http://localhost:${PORT}/", within: "30s" },
  },
];

function manifest(): Manifest {
  return {
    openscaffold: "0.1.0",
    schema_version: 1,
    stack: "python-react",
    preset: "default",
    agents: ["claude"],
    fragments: [],
    vars: { project_name: "demo" },
    env: { PORT: "8000" },
    verify: steps,
    verify_hash: hashVerify(steps),
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
  };
}

describe("hashVerify", () => {
  it("applies defaults and ignores key order and extra props", () => {
    const minimal = [{ name: "lint", run: "make lint" }] as VerifyStep[];
    const full = [{ tags: [], phase: "check", run: "make lint", name: "lint", owner: "x" }];
    expect(hashVerify(minimal)).toBe(hashVerify(full as VerifyStep[]));
    expect(hashVerify(minimal)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a step changes", () => {
    const a = [{ name: "lint", run: "make lint" }] as VerifyStep[];
    const b = [{ name: "lint", run: "true" }] as VerifyStep[];
    expect(hashVerify(a)).not.toBe(hashVerify(b));
  });
});

describe("readManifest / writeManifest", () => {
  it("round-trips with a header comment", () => {
    const dir = tmp();
    writeManifest(dir, manifest());
    const text = readFileSync(join(dir, MANIFEST_PATH), "utf8");
    expect(text.startsWith("# Written by openscaffold")).toBe(true);
    expect(text).toContain("definition of done");
    expect(readManifest(dir)).toEqual(manifest());
  });

  it("returns undefined when missing", () => {
    expect(readManifest(tmp())).toBeUndefined();
  });

  it("throws OpenScaffoldError with a hint when invalid", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".openscaffold"));
    writeFileSync(join(dir, MANIFEST_PATH), "openscaffold: 1\nverify: nope\n");
    expect(() => readManifest(dir)).toThrow(OpenScaffoldError);
    try {
      readManifest(dir);
    } catch (err) {
      expect((err as OpenScaffoldError).hint).toBeTruthy();
      expect((err as Error).message).toContain("verify");
    }
    writeFileSync(join(dir, MANIFEST_PATH), "a: [unclosed\n");
    expect(() => readManifest(dir)).toThrow(/not valid YAML/);
  });
});
