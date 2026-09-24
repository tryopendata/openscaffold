import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  it("drops a Go major-version suffix from the module path", () => {
    writeFileSync(join(repo, "go.mod"), "module github.com/acme/widget/v2\n");
    expect(inferProjectName(repo)).toBe("widget");
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

  it("doesn't re-apply stack defaults the user excluded", async () => {
    await runNew({ ...sb.opts, stack: "app", dir: "proj", without: ["deploy"] });
    const result = await runAdd({ ...sb.opts, dir: "proj", fragments: ["extra"] });
    expect(result.added).toEqual(["extra"]);
    expect(readManifest(join(sb.cwd, "proj"))?.fragments).toEqual(["agent-ops", "extra"]);
  });

  it("parks a file the stack already wrote instead of failing on ownership", async () => {
    await runNew({ ...sb.opts, stack: "app", dir: "proj", sandbox: true });
    const result = await runAdd({ ...sb.opts, dir: "proj", fragments: ["lonely"] });
    expect(result.written).toEqual([".gitignore"]);
    expect(result.mergeNeeded).toEqual(["README.md"]);
    expect(readFileSync(join(sb.cwd, "proj/.openscaffold/incoming/README.md"), "utf8")).toBe(
      "# proj readme\n",
    );
  });

  it("uses the config preset when there's no manifest", async () => {
    mkdirSync(join(sb.home, ".openscaffold"), { recursive: true });
    writeFileSync(join(sb.home, ".openscaffold", "config.yaml"), "preset: sandbox\n");
    const result = await runAdd({ ...sb.opts, dir: "repo", fragments: ["deploy"] });
    expect(result.warnings.join("\n")).toContain("deploy is a deploy fragment");
    expect(readManifest(repo)?.preset).toBe("sandbox");
  });

  it("keeps unreconciled incoming files from an earlier run and flags them", async () => {
    mkdirSync(join(repo, ".openscaffold/incoming"), { recursive: true });
    writeFileSync(join(repo, ".openscaffold/incoming/old.json"), "{}");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    const result = await runAdd({ ...sb.opts, dir: "repo", fragments: ["lonely"] });
    expect(readFileSync(join(repo, ".openscaffold/incoming/old.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(repo, ".openscaffold/incoming/.gitignore"), "utf8")).toBe("dist/\n");
    expect(result.warnings.join("\n")).toMatch(/incoming.*old\.json/);
    expect(result.mergeNeeded).toEqual([".gitignore", "old.json"]);
    expect(readFileSync(result.brief, "utf8")).toContain("`old.json` (incoming:");
  });

  it("parks the same path again when a later add wants it too", async () => {
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(repo, ".claude/settings.json"), '{"mine":true}');
    const first = await runAdd({ ...sb.opts, dir: "repo", fragments: ["agent-ops"] });
    expect(first.mergeNeeded).toEqual([".claude/settings.json"]);

    const second = await runAdd({ ...sb.opts, dir: "repo", fragments: ["extra"] });
    expect(second.mergeNeeded).toEqual([".claude/settings.json"]);
    const parked = JSON.parse(
      readFileSync(join(repo, ".openscaffold/incoming/.claude/settings.json"), "utf8"),
    );
    expect(parked.permissions.allow).toEqual(["Bash(repo *)"]);
    expect(readFileSync(join(repo, ".claude/settings.json"), "utf8")).toBe('{"mine":true}');
    expect(readManifest(repo)?.fragments).toEqual(["agent-ops", "extra"]);
    expect(readFileSync(second.brief, "utf8")).toContain("Extra tooling");
  });

  it("writes nothing when a fragment's conditional markers are malformed", async () => {
    const bad = join(sb.home, ".openscaffold/fragments/bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(
      join(bad, "FRAGMENT.md"),
      "---\nschema_version: 1\nid: bad\nkind: fragment\nname: Bad\ndescription: t\ncategory: tooling\n---\n\n<!-- openscaffold:when agent=claude -->\nhi\n<!-- openscaffold:end -->\n",
    );
    mkdirSync(join(bad, "files"));
    writeFileSync(join(bad, "files", "bad.txt"), "x");
    await expect(runAdd({ ...sb.opts, dir: "repo", fragments: ["bad"] })).rejects.toMatchObject({
      code: "bad_conditional",
    });
    expect(existsSync(join(repo, "bad.txt"))).toBe(false);
    expect(existsSync(join(repo, ".openscaffold"))).toBe(false);
  });

  it("refuses to write the manifest or brief through a symlinked .openscaffold", async () => {
    const outside = join(sb.cwd, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(repo, ".openscaffold"));
    await expect(runAdd({ ...sb.opts, dir: "repo", fragments: ["lonely"] })).rejects.toMatchObject({
      code: "render_outside_project",
    });
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(repo, "README.md"))).toBe(false);
  });

  it("refuses a missing target dir, an empty fragment list, and unknown fragment ids", async () => {
    await expect(
      runAdd({ ...sb.opts, dir: "nope", fragments: ["agent-ops"] }),
    ).rejects.toMatchObject({ code: "target_missing" });
    await expect(runAdd({ ...sb.opts, dir: "repo", fragments: [] })).rejects.toMatchObject({
      code: "bad_option",
      message: "no fragments given",
    });
    await expect(
      runAdd({ ...sb.opts, dir: "repo", fragments: ["agent-opz"] }),
    ).rejects.toMatchObject({ hint: expect.stringContaining('Did you mean "agent-ops"') });
    expect(existsSync(join(repo, ".openscaffold"))).toBe(false);
  });

  it("warns about edited verify steps and keeps the edit detectable", async () => {
    const created = await runNew({ ...sb.opts, stack: "app", dir: "proj", sandbox: true });
    const path = join(created.dir, ".openscaffold/manifest.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace("run: bun test", 'run: "true"'));
    const result = await runAdd({ ...sb.opts, dir: "proj", fragments: ["extra"] });
    expect(result.warnings.join("\n")).toContain("were edited since openscaffold generated them");
    const after = readManifest(created.dir);
    expect(after?.verify.map((s) => s.name)).toContain("extra-check");
    expect(after?.verify_hash).not.toBe(hashVerify(after?.verify ?? []));
  });
});
