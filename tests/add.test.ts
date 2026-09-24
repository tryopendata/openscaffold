import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdd } from "../src/commands/add.js";
import { runNew } from "../src/commands/new.js";
import { hashVerify, readManifest } from "../src/manifest.js";
import { inferProjectName } from "../src/vars.js";
import { makeSandbox, type Sandbox } from "./helpers/scaffold.js";

let sb: Sandbox;
let repo: string;
beforeEach(() => {
  sb = makeSandbox();
  repo = join(sb.cwd, "repo");
  mkdirSync(repo);
});
afterEach(() => sb.cleanup());

describe("inferProjectName", () => {
  it("reads package.json, pyproject.toml, go.mod, then falls back to the dir name", () => {
    expect(inferProjectName(repo)).toBe("repo");
    writeFileSync(join(repo, "go.mod"), "module github.com/acme/widget\n\ngo 1.30\n");
    expect(inferProjectName(repo)).toBe("widget");
    writeFileSync(
      join(repo, "pyproject.toml"),
      '[build-system]\nrequires = ["x"]\n\n[project]\nname = "py-widget"\nversion = "0.1.0"\n',
    );
    expect(inferProjectName(repo)).toBe("py-widget");
    writeFileSync(join(repo, "package.json"), '{"name":"@acme/js-widget"}');
    expect(inferProjectName(repo)).toBe("js-widget");
  });
});

describe("runAdd", () => {
  it("creates a manifest in a bare repo with inferred vars", async () => {
    writeFileSync(join(repo, "package.json"), '{"name":"@acme/widget"}');
    const result = await runAdd({ ...sb.opts, dir: "repo", fragments: ["agent-ops"] });
    expect(result.manifestCreated).toBe(true);
    expect(result.added).toEqual(["agent-ops"]);
    expect(result.written).toContain("AGENTS.md");
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe("# widget\n");

    const manifest = readManifest(repo);
    expect(manifest?.stack).toBeNull();
    expect(manifest?.fragments).toEqual(["agent-ops"]);
    expect(manifest?.vars).toMatchObject({ project_name: "widget", project_slug: "widget" });
    expect(manifest?.verify.map((s) => s.name)).toEqual(["agents-md"]);
    expect(manifest?.verify_hash).toBe(hashVerify(manifest?.verify ?? []));
    expect(existsSync(join(repo, ".openscaffold/BRIEF.md"))).toBe(true);
  });

  it("appends fragments and verify steps to an existing manifest", async () => {
    const created = await runNew({ ...sb.opts, stack: "app", dir: "proj", sandbox: true });
    const before = readManifest(created.dir);
    const result = await runAdd({ ...sb.opts, dir: "proj", fragments: ["extra"] });

    expect(result.stack).toBe("app");
    expect(result.added).toEqual(["extra"]);
    const after = readManifest(created.dir);
    expect(after?.fragments).toEqual(["agent-ops", "extra"]);
    expect(after?.verify.map((s) => s.name)).toEqual([
      ...(before?.verify.map((s) => s.name) ?? []),
      "extra-check",
    ]);
    expect(after?.verify_hash).toBe(hashVerify(after?.verify ?? []));
    expect(after?.env).toEqual({ PORT_WEB: "3000", PORT_RR: "9000" });
    expect(after?.created).toBe(before?.created);
    expect(after?.vars).toEqual(before?.vars);
    // The stack's own files aren't re-offered as merges.
    expect(result.mergeNeeded).toEqual([".claude/settings.json"]);

    await expect(runAdd({ ...sb.opts, dir: "proj", fragments: ["extra"] })).rejects.toMatchObject({
      code: "nothing_to_add",
    });
  });

  it("skips existing files, parks its version under incoming, and lists them in the brief", async () => {
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    const result = await runAdd({ ...sb.opts, dir: "repo", fragments: ["lonely"] });
    expect(result.written).toEqual(["README.md"]);
    expect(result.mergeNeeded).toEqual([".gitignore"]);
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe("node_modules/\n");
    expect(readFileSync(join(repo, ".openscaffold/incoming/.gitignore"), "utf8")).toBe("dist/\n");
    const brief = readFileSync(result.brief, "utf8");
    expect(brief).toContain("## Merge needed");
    expect(brief).toContain("`.gitignore` (incoming: `.openscaffold/incoming/.gitignore`)");
  });
});
