import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runNew } from "../src/commands/new.js";
import { hashVerify, readManifest } from "../src/manifest.js";
import { makeSandbox, type Sandbox } from "./helpers/scaffold.js";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === ".git") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

describe("runNew", () => {
  it("scaffolds a stack into an empty directory", async () => {
    const result = await runNew({ ...sb.opts, stack: "app", dir: "demo", with: ["extra"] });
    const dir = join(sb.cwd, "demo");
    expect(result.dir).toBe(dir);
    expect(result.fragments).toEqual(["agent-ops", "deploy", "extra"]);
    expect(result.agents).toEqual(["claude", "codex", "opencode", "cursor"]);
    expect(tree(dir)).toEqual([
      ".claude/hooks/check.sh",
      ".claude/settings.json",
      ".github/workflows/ci.yml",
      ".openscaffold/BRIEF.md",
      ".openscaffold/manifest.yaml",
      "AGENTS.md",
      "README.md",
      "scripts/hook.sh",
    ]);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe(
      "# demo\n\nBy Git User (demo, 2026).\n",
    );
    expect(readFileSync(join(dir, ".github/workflows/ci.yml"), "utf8")).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions syntax
      "${{ secrets.TOKEN }}",
    );
    expect(statSync(join(dir, ".claude/hooks/check.sh")).mode & 0o111).not.toBe(0);
    expect(JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"))).toEqual({
      permissions: { deny: ["Bash(rm -rf /)"], allow: ["Bash(demo *)"] },
      hooks: { PreToolUse: [{ command: "a" }, { command: "b" }] },
    });

    const manifest = readManifest(dir);
    expect(manifest).toBeDefined();
    expect(manifest?.stack).toBe("app");
    expect(manifest?.fragments).toEqual(["agent-ops", "deploy", "extra"]);
    expect(manifest?.env).toEqual({ PORT_WEB: "3000", PORT_RR: "9000" });
    expect(manifest?.vars).toMatchObject({ project_name: "demo", author: "Git User" });
    expect(manifest?.verify.map((s) => s.name)).toEqual([
      "install",
      "test",
      "build",
      "web",
      "agents-md",
      "deploy-check",
      "extra-check",
    ]);
    expect(manifest?.verify_hash).toBe(hashVerify(manifest?.verify ?? []));
    expect(readFileSync(join(dir, ".openscaffold/manifest.yaml"), "utf8")).not.toContain("owner");

    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, encoding: "utf8" }),
    ).toContain("true");

    expect(result.missingTools).toEqual([{ owner: "extra", tool: "frobnicate" }]);
    expect(sb.errs.some((l) => l.includes("frobnicate"))).toBe(true);
    expect(result.handoff).toEqual({ kind: "print", reason: "stdout is not a terminal" });
    expect(sb.out.join("\n")).toContain("Read .openscaffold/BRIEF.md and carry it out");
  });

  it("defaults the directory to the slugged --name, then the stack id", async () => {
    const named = await runNew({ ...sb.opts, stack: "app", name: "My Thing" });
    expect(named.dir).toBe(join(sb.cwd, "my-thing"));
    expect(readManifest(named.dir)?.vars).toMatchObject({
      project_name: "My Thing",
      project_slug: "my-thing",
    });
    const plain = await runNew({ ...sb.opts, stack: "app" });
    expect(plain.dir).toBe(join(sb.cwd, "app"));
  });

  it("applies --sandbox: drops deploy fragments and records the preset", async () => {
    const result = await runNew({ ...sb.opts, stack: "app", dir: "demo", sandbox: true });
    expect(result.fragments).toEqual(["agent-ops"]);
    expect(result.preset).toBe("sandbox");
    expect(readManifest(result.dir)?.preset).toBe("sandbox");
    expect(result.warnings.some((w) => w.includes("dropped deploy"))).toBe(true);
  });

  it("uses config defaults for agents, scope, and author", async () => {
    mkdirSync(join(sb.home, ".openscaffold"));
    writeFileSync(
      join(sb.home, ".openscaffold", "config.yaml"),
      "agents: [codex]\nauthor: Config Author\npackage_scope: acme\npreset: sandbox\n",
    );
    const result = await runNew({
      ...sb.opts,
      stack: "app",
      dir: "demo",
      env: { CLAUDECODE: "1" },
    });
    expect(result.agents).toEqual(["claude", "codex"]);
    expect(result.preset).toBe("sandbox");
    expect(readManifest(result.dir)?.vars).toMatchObject({
      author: "Config Author",
      package_scope: "acme",
    });
    expect(result.handoff).toEqual({ kind: "inside-agent", agent: "claude" });
    expect(sb.out.join("\n")).toContain("NEXT STEP FOR THE AGENT");
  });

  it("refuses a non-empty directory but ignores .git and .DS_Store", async () => {
    const dir = join(sb.cwd, "busy");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".DS_Store"), "");
    await runNew({ ...sb.opts, stack: "app", dir: "busy" });

    mkdirSync(join(sb.cwd, "full"));
    writeFileSync(join(sb.cwd, "full", "main.go"), "package main");
    await expect(runNew({ ...sb.opts, stack: "app", dir: "full" })).rejects.toMatchObject({
      code: "target_not_empty",
      hint: expect.stringContaining("openscaffold add"),
    });
  });

  it("prints the documented --json shape and never launches", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const spawn = vi.fn(async () => 0);
      await runNew({
        ...sb.opts,
        stack: "app",
        dir: "demo",
        json: true,
        isTTY: true,
        hasTool: () => true,
        spawn,
      });
      expect(spawn).not.toHaveBeenCalled();
      const printed = JSON.parse(String(write.mock.calls[0]?.[0]));
      expect(Object.keys(printed).sort()).toEqual(
        [
          "agents",
          "brief",
          "dir",
          "fragments",
          "missingTools",
          "next",
          "preset",
          "skipped",
          "stack",
          "verifyCommand",
          "warnings",
          "written",
        ].sort(),
      );
      expect(printed.verifyCommand).toBe("npx openscaffold verify");
      expect(printed.brief).toBe(join(sb.cwd, "demo", ".openscaffold", "BRIEF.md"));
      expect(sb.out).toEqual([]);
    } finally {
      write.mockRestore();
    }
  });

  it("launches an agent from a TTY via the injected spawner", async () => {
    const spawn = vi.fn(async () => 0);
    const result = await runNew({
      ...sb.opts,
      stack: "app",
      dir: "demo",
      isTTY: true,
      hasTool: () => true,
      spawn,
    });
    expect(result.handoff).toMatchObject({ kind: "launch", bin: "claude" });
    expect(spawn).toHaveBeenCalledWith(
      "claude",
      [expect.stringContaining(".openscaffold/BRIEF.md")],
      result.dir,
    );
  });
});
