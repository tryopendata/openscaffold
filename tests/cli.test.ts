import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashVerify, writeManifest } from "../src/manifest.js";
import type { VerifyStep } from "../src/schema/index.js";

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

  // Bun ignores a closed stdout; node raises EPIPE, so these run a node bundle of the CLI.
  describe("under node with a closed output pipe", () => {
    let out: string;
    let bundle: string;
    beforeAll(async () => {
      out = mkdtempSync(join(tmpdir(), "os-cli-node-"));
      bundle = join(out, "dist/cli.mjs");
      // Laid out like the package: dist/ next to package.json and registry/.
      await execa("bun", ["build", CLI, "--target", "node", "--outfile", bundle]);
      cpSync(join(ROOT, "package.json"), join(out, "package.json"));
      symlinkSync(join(ROOT, "registry"), join(out, "registry"));
    });
    afterAll(() => rmSync(out, { recursive: true, force: true }));

    it("exits quietly", async () => {
      // `true` exits without reading, so the CLI's first write hits a closed pipe.
      const res = await execa(
        "bash",
        ["-c", `node "${bundle}" list | true; echo "\${PIPESTATUS[0]}"`],
        { reject: false, env: { OPENSCAFFOLD_OFFLINE: "1" } },
      );
      expect(res.stderr).not.toMatch(/EPIPE|Error/);
      expect(res.stdout.trim()).toBe("0");
    });

    it("keeps running verify to its real exit code and teardown", async () => {
      const dir = mkdtempSync(join(tmpdir(), "os-cli-verify-"));
      try {
        const verify: VerifyStep[] = [
          { name: "one", run: "echo one", phase: "check", tags: [] },
          { name: "two", run: "sleep 1; echo two", phase: "check", tags: [] },
          { name: "fail", run: "exit 1", phase: "check", tags: [] },
          { name: "down", run: "touch torn-down", phase: "teardown", tags: [] },
        ];
        writeManifest(dir, {
          openscaffold: "0.1.0",
          schema_version: 1,
          stack: null,
          preset: "default",
          agents: [],
          fragments: [],
          vars: {},
          env: {},
          verify,
          verify_hash: hashVerify(verify),
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
        });
        // head exits after the first line, so every later write hits a closed pipe.
        const res = await execa(
          "bash",
          ["-c", `node "${bundle}" verify --dir "${dir}" | head -1; echo "\${PIPESTATUS[0]}"`],
          { reject: false, env: { OPENSCAFFOLD_OFFLINE: "1" } },
        );
        expect(res.stdout.trim().split("\n").at(-1)).toBe("1");
        expect(existsSync(join(dir, "torn-down"))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
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
