import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "src/cli.ts");
const run = (...args: string[]) =>
  execa("bun", [CLI, ...args], {
    reject: false,
    env: { OPENSCAFFOLD_OFFLINE: "1" },
  });

describe("cli", () => {
  it("prints the guide with no arguments", async () => {
    const res = await run();
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Workflow (for agents)");
  });

  it("suggests the closest command for a typo instead of printing the guide", async () => {
    const res = await run("nwe");
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("unknown command 'nwe'");
    expect(res.stderr).toContain("new");
    expect(res.stderr).not.toContain("too many arguments");
    expect(res.stdout).not.toContain("Workflow (for agents)");
  });

  it("exits quietly under node when its output pipe closes early", async () => {
    // Bun ignores a closed stdout; node raises EPIPE, so this runs a node bundle of the CLI.
    const out = mkdtempSync(join(tmpdir(), "os-cli-node-"));
    try {
      // Laid out like the package: dist/ next to package.json and registry/.
      await execa("bun", [
        "build",
        CLI,
        "--target",
        "node",
        "--outfile",
        join(out, "dist/cli.mjs"),
      ]);
      cpSync(join(ROOT, "package.json"), join(out, "package.json"));
      symlinkSync(join(ROOT, "registry"), join(out, "registry"));
      // `true` exits without reading, so the CLI's first write hits a closed pipe.
      const res = await execa(
        "bash",
        ["-c", `node "${join(out, "dist/cli.mjs")}" list | true; echo "\${PIPESTATUS[0]}"`],
        { reject: false, env: { OPENSCAFFOLD_OFFLINE: "1" } },
      );
      expect(res.stderr).not.toMatch(/EPIPE|Error/);
      expect(res.stdout.trim()).toBe("0");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("prints --json failures as a JSON error on stdout", async () => {
    const res = await run("show", "no-such-entry", "--json");
    expect(res.exitCode).toBe(1);
    const body = JSON.parse(res.stdout);
    expect(body.error.code).toEqual(expect.any(String));
    expect(body.error.message).toContain("no-such-entry");
    expect(body.error).toHaveProperty("hint");

    const opt = await run("list", "--bogus", "--json");
    expect(opt.exitCode).toBe(1);
    expect(JSON.parse(opt.stdout).error.message).toContain("--bogus");
  });

  it("keeps plain-text errors without --json", async () => {
    const res = await run("show", "no-such-entry");
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/^error: /);
    expect(res.stdout).toBe("");
  });

  it("accepts --offline on list and show, as the guide says", async () => {
    expect((await run("list", "--offline", "--json")).exitCode).toBe(0);
    expect((await run("show", "go-cli", "--offline", "--json")).exitCode).toBe(0);
    expect((await run()).stdout).toMatch(/--offline/);
  });
});
