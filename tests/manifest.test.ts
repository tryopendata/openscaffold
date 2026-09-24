import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  it("is the same for steps that differ only by defaults, key order, or extra props", () => {
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
  it("writes a commented manifest that reads back unchanged", () => {
    const dir = tmp();
    writeManifest(dir, manifest());
    const text = readFileSync(join(dir, MANIFEST_PATH), "utf8");
    expect(text.startsWith("# Written by openscaffold")).toBe(true);
    expect(text).toContain("definition of done");
    expect(readManifest(dir)).toEqual(manifest());
  });

  it("refuses to write through a symlinked .openscaffold that leads outside the project", () => {
    const root = tmp();
    const project = join(root, "p");
    const outside = join(root, "outside");
    mkdirSync(project);
    mkdirSync(outside);
    symlinkSync(outside, join(project, ".openscaffold"));
    expect(() => writeManifest(project, manifest())).toThrow(
      expect.objectContaining({ code: "render_outside_project" }),
    );
    expect(existsSync(join(outside, "manifest.yaml"))).toBe(false);
  });

  it("returns undefined when the project has no manifest", () => {
    expect(readManifest(tmp())).toBeUndefined();
  });

  it("throws a hinted error naming the field when the manifest doesn't match the schema", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".openscaffold"));
    writeFileSync(join(dir, MANIFEST_PATH), "openscaffold: 1\nverify: nope\n");
    const err = (() => {
      try {
        readManifest(dir);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(OpenScaffoldError);
    expect((err as OpenScaffoldError).hint).toBeTruthy();
    expect((err as Error).message).toContain("verify");
  });

  it("throws when the manifest isn't valid YAML", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".openscaffold"));
    writeFileSync(join(dir, MANIFEST_PATH), "a: [unclosed\n");
    expect(() => readManifest(dir)).toThrow(/not valid YAML/);
  });
});
