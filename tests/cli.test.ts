import { resolve } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { GUIDE } from "../src/commands/guide.js";

const CLI = resolve(import.meta.dirname, "../src/cli.ts");
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
    expect(GUIDE).toMatch(/--offline/);
  });
});
