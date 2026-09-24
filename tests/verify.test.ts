import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenScaffoldError } from "../src/errors.js";
import { hashVerify, writeManifest } from "../src/manifest.js";
import type { VerifyStep } from "../src/schema/index.js";
import { runVerify, type VerifyReport } from "../src/verify.js";

const NODE = JSON.stringify(process.execPath);
const CLI = resolve(import.meta.dirname, "../src/cli.ts");

const SERVER = `
import http from "node:http";
import fs from "node:fs";
const port = Number(process.env.PORT_API);
http.createServer((req, res) => res.end("ok")).listen(port, () => {
  console.log("listening on " + port);
  if (process.env.PID_FILE) fs.writeFileSync(process.env.PID_FILE, String(process.pid));
});
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type StepInput = Partial<VerifyStep> & { name: string; run: string };

function project(
  steps: StepInput[],
  opts: { preset?: "default" | "sandbox"; env?: Record<string, string>; hash?: string } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "os-verify-"));
  dirs.push(dir);
  writeFileSync(join(dir, "server.mjs"), SERVER);
  const verify = steps.map((s) => ({ phase: "check", tags: [], ...s })) as VerifyStep[];
  writeManifest(dir, {
    openscaffold: "0.1.0",
    schema_version: 1,
    stack: null,
    preset: opts.preset ?? "default",
    agents: [],
    fragments: [],
    vars: {},
    env: opts.env ?? {},
    verify,
    verify_hash: opts.hash ?? hashVerify(verify),
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
  });
  return dir;
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => ok(typeof addr === "object" && addr ? addr.port : 0));
    });
  });
}

function portFree(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const srv = createServer();
    srv.once("error", () => ok(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => ok(true)));
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A killed process can linger briefly as a zombie until it's reaped, so poll rather than
// checking once. The timeout is an upper bound, not a delay.
async function expectGone(pid: number): Promise<void> {
  await vi.waitFor(() => expect(alive(pid), `pid ${pid} still running`).toBe(false), {
    timeout: 5000,
    interval: 25,
  });
}

async function expectPortFree(port: number): Promise<void> {
  await vi.waitFor(async () => expect(await portFree(port), `port ${port} in use`).toBe(true), {
    timeout: 5000,
    interval: 25,
  });
}

// Reads a pid a shell step writes with `echo $! > file`, waiting until the write lands.
async function readPid(file: string): Promise<number> {
  return vi.waitFor(
    () => {
      const pid = Number(readFileSync(file, "utf8"));
      expect(pid).toBeGreaterThan(0);
      return pid;
    },
    { timeout: 10_000, interval: 25 },
  );
}

const byName = (r: VerifyReport, name: string) => r.steps.find((s) => s.name === name);
const statuses = (r: VerifyReport) => Object.fromEntries(r.steps.map((s) => [s.name, s.status]));

describe("runVerify", () => {
  it("passes when every step passes, running phases in order", async () => {
    const dir = project([
      { name: "tear", run: "echo tear >> order.txt", phase: "teardown" },
      { name: "check-a", run: "echo check >> order.txt" },
      { name: "install", run: "echo setup >> order.txt", phase: "setup" },
    ]);
    const r = await runVerify({ projectDir: dir });
    expect(r.ok).toBe(true);
    expect(r.totals).toEqual({ passed: 3, failed: 0, skipped: 0 });
    expect(r.warnings).toEqual([]);
    expect(readFileSync(join(dir, "order.txt"), "utf8")).toBe("setup\ncheck\ntear\n");
    expect(r.steps.map((s) => s.name)).toEqual(["install", "check-a", "tear"]);
  });

  it("keeps running checks after one fails and reports the output tail", async () => {
    const dir = project([
      { name: "bad", run: "echo something broke; exit 2" },
      { name: "good", run: "true" },
    ]);
    const r = await runVerify({ projectDir: dir });
    expect(r.ok).toBe(false);
    expect(statuses(r)).toEqual({ bad: "failed", good: "passed" });
    expect(byName(r, "bad")?.exitCode).toBe(2);
    expect(byName(r, "bad")?.outputTail).toContain("something broke");
  });

  it("skips later phases when setup fails but still runs teardown", async () => {
    const dir = project([
      { name: "install", run: "exit 1", phase: "setup" },
      { name: "install-2", run: "true", phase: "setup" },
      { name: "lint", run: "true" },
      {
        name: "api",
        run: "true",
        phase: "serve",
        expect: { http: "http://127.0.0.1:1/", within: "5s" },
      },
      { name: "down", run: "touch torn-down", phase: "teardown" },
    ]);
    const r = await runVerify({ projectDir: dir });
    expect(statuses(r)).toEqual({
      install: "failed",
      "install-2": "skipped",
      lint: "skipped",
      api: "skipped",
      down: "passed",
    });
    expect(byName(r, "lint")?.reason).toContain("install");
    expect(existsSync(join(dir, "torn-down"))).toBe(true);
  });

  it("sandbox preset skips prod-tagged steps unless all is set", async () => {
    const steps = [
      { name: "build", run: "true", tags: ["prod"] },
      { name: "lint", run: "true" },
    ];
    const dir = project(steps, { preset: "sandbox" });
    const r = await runVerify({ projectDir: dir });
    expect(statuses(r)).toEqual({ build: "skipped", lint: "passed" });
    expect(byName(r, "build")?.reason).toContain("--all");
    const all = await runVerify({ projectDir: dir, all: true });
    expect(statuses(all)).toEqual({ build: "passed", lint: "passed" });
    const dflt = await runVerify({ projectDir: project(steps) });
    expect(statuses(dflt)).toEqual({ build: "passed", lint: "passed" });
  });

  it("skips steps by tag and restricts to --only", async () => {
    const dir = project([
      { name: "setup", run: "true", phase: "setup" },
      { name: "slow", run: "true", tags: ["slow"] },
      { name: "lint", run: "true" },
      { name: "test", run: "true" },
    ]);
    const r = await runVerify({ projectDir: dir, skipTags: ["slow"] });
    expect(statuses(r)).toEqual({
      setup: "passed",
      slow: "skipped",
      lint: "passed",
      test: "passed",
    });
    const only = await runVerify({ projectDir: dir, only: ["lint"] });
    expect(statuses(only)).toEqual({
      setup: "passed",
      slow: "skipped",
      lint: "passed",
      test: "skipped",
    });
    await expect(runVerify({ projectDir: dir, only: ["nope"] })).rejects.toThrow(/nope/);
  });

  it("passes manifest env to steps, overridden by the caller env", async () => {
    const dir = project([{ name: "env", run: 'test "$FOO" = bar && test "$BAZ" = over' }], {
      env: { FOO: "bar", BAZ: "default" },
    });
    const r = await runVerify({ projectDir: dir, env: { ...process.env, BAZ: "over" } });
    expect(r.ok).toBe(true);
    const r2 = await runVerify({ projectDir: dir, env: { PATH: process.env.PATH } });
    expect(r2.ok).toBe(false);
  });

  it("serve step passes the probe with a real server, expanding env in the URL", async () => {
    const port = await freePort();
    const dir = project(
      [
        {
          name: "api",
          run: `${NODE} server.mjs`,
          phase: "serve",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: ${VAR} is verify env syntax
          expect: { http: "http://127.0.0.1:${PORT_API}/health", within: "20s" },
        },
      ],
      { env: { PORT_API: "1" } },
    );
    const r = await runVerify({ projectDir: dir, env: { ...process.env, PORT_API: String(port) } });
    expect(byName(r, "api")?.status).toBe("passed");
    await expectPortFree(port);
  });

  it("kills the whole process group of a serve step, including children", async () => {
    const port = await freePort();
    const dir = project(
      [
        {
          name: "api",
          run: `sh -c '${process.execPath} server.mjs & wait'`,
          phase: "serve",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: ${VAR} is verify env syntax
          expect: { http: "http://127.0.0.1:${PORT_API}/", within: "20s" },
        },
      ],
      { env: { PORT_API: String(port), PID_FILE: "server.pid" } },
    );
    const r = await runVerify({ projectDir: dir });
    expect(byName(r, "api")?.status).toBe("passed");
    const pid = await readPid(join(dir, "server.pid"));
    await expectGone(pid);
    await expectPortFree(port);
  });

  it("fails a serve step whose probe never succeeds, in bounded time", async () => {
    const port = await freePort();
    const dir = project([
      {
        name: "api",
        run: "sleep 30",
        phase: "serve",
        expect: { http: `http://127.0.0.1:${port}/`, within: "1s" },
      },
    ]);
    const start = Date.now();
    const r = await runVerify({ projectDir: dir });
    expect(Date.now() - start).toBeLessThan(8000);
    expect(byName(r, "api")?.status).toBe("failed");
    expect(byName(r, "api")?.reason).toContain("within 1s");
  });

  it("fails a serve step whose process exits before the probe succeeds", async () => {
    const port = await freePort();
    const dir = project([
      {
        name: "api",
        run: "echo boom; exit 3",
        phase: "serve",
        expect: { http: `http://127.0.0.1:${port}/`, within: "30s" },
      },
    ]);
    const start = Date.now();
    const r = await runVerify({ projectDir: dir });
    expect(Date.now() - start).toBeLessThan(5000);
    const api = byName(r, "api");
    expect(api?.status).toBe("failed");
    expect(api?.reason).toContain("code 3");
    expect(api?.outputTail).toContain("boom");
  });

  it("fails a serve step at once when its probe URL can't be expanded or parsed", async () => {
    const dir = project([
      {
        name: "api",
        run: "touch started; sleep 30",
        phase: "serve",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: ${VAR} is verify env syntax
        expect: { http: "http://127.0.0.1:${PORT_NOPE}/", within: "30s" },
      },
      {
        name: "web",
        run: "sleep 30",
        phase: "serve",
        expect: { http: "not a url", within: "30s" },
      },
    ]);
    const start = Date.now();
    const r = await runVerify({ projectDir: dir, env: { PATH: process.env.PATH } });
    expect(Date.now() - start).toBeLessThan(3000);
    expect(byName(r, "api")?.status).toBe("failed");
    expect(byName(r, "api")?.reason).toContain("PORT_NOPE");
    expect(byName(r, "web")?.status).toBe("failed");
    expect(byName(r, "web")?.reason).toContain("not a valid");
    expect(existsSync(join(dir, "started"))).toBe(false);
  });

  it("fails a serve step at once when something already answers on its URL", async () => {
    const port = await freePort();
    const server = createHttpServer((_req, res) => res.end("stale"));
    await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
    try {
      const dir = project(
        [
          {
            name: "web",
            run: "touch started; sleep 30",
            phase: "serve",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: ${VAR} is verify env syntax
            expect: { http: "http://127.0.0.1:${PORT_WEB}/", within: "30s" },
          },
        ],
        { env: { PORT_WEB: String(port) } },
      );
      const r = await runVerify({ projectDir: dir });
      const web = byName(r, "web");
      expect(web?.status).toBe("failed");
      expect(web?.reason).toContain(`something is already listening on http://127.0.0.1:${port}/`);
      expect(web?.reason).toContain("PORT_WEB");
      expect(existsSync(join(dir, "started"))).toBe(false);
    } finally {
      await new Promise((ok) => server.close(ok));
    }
  });

  it("explains a serve command that exits 0 before the probe succeeds (daemonized)", async () => {
    const port = await freePort();
    const dir = project([
      {
        name: "api",
        run: "echo detached",
        phase: "serve",
        expect: { http: `http://127.0.0.1:${port}/`, within: "30s" },
      },
    ]);
    const r = await runVerify({ projectDir: dir });
    const api = byName(r, "api");
    expect(api?.status).toBe("failed");
    expect(api?.reason).toMatch(/daemonized|background/);
    expect(api?.reason).toContain("foreground");
  });

  it("kills a background process a check step leaves holding its output, instead of hanging", async () => {
    const dir = project([{ name: "leaky", run: "sleep 30 & echo $! > bg.pid; echo started" }]);
    const start = Date.now();
    const r = await runVerify({ projectDir: dir });
    expect(Date.now() - start).toBeLessThan(8000);
    const leaky = byName(r, "leaky");
    expect(leaky?.status).toBe("passed");
    expect(leaky?.outputTail).toContain("killed processes this step left running");
    await expectGone(await readPid(join(dir, "bg.pid")));
  });

  it("warns when the verify steps no longer match the stored hash", async () => {
    const dir = project([{ name: "lint", run: "true" }], { hash: "0".repeat(64) });
    const r = await runVerify({ projectDir: dir });
    expect(r.warnings.join("\n")).toMatch(/edited since openscaffold generated them/);
    expect(r.warnings.join("\n")).toMatch(/counts as a failure/);
  });

  it("throws a hinted error when there is no manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "os-verify-"));
    dirs.push(dir);
    const err = await runVerify({ projectDir: dir }).catch((e) => e);
    expect(err).toBeInstanceOf(OpenScaffoldError);
    expect(err.hint).toMatch(/openscaffold new/);
    expect(err.hint).toMatch(/openscaffold add/);
  });
});

describe("verify command", () => {
  it("prints each command, a summary, and exits 1 on failure", async () => {
    const dir = project([
      { name: "lint", run: "echo linted" },
      { name: "test", run: "echo 'test failed here'; exit 1" },
    ]);
    const res = await execa("bun", [CLI, "verify", "--dir", dir], { reject: false });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("$ echo linted");
    expect(res.stdout).toContain("test failed here");
    expect(res.stdout).toContain("verify: 1 passed, 1 failed, 0 skipped");
    expect(res.stdout).toContain("don't weaken the steps");

    const json = await execa("bun", [CLI, "verify", "--dir", dir, "--json"], { reject: false });
    expect(JSON.parse(json.stdout).totals).toEqual({ passed: 1, failed: 1, skipped: 0 });
  });

  it("accepts comma-separated --only and --skip-tag lists", async () => {
    const dir = project([
      { name: "lint", run: "true" },
      { name: "types", run: "true" },
      { name: "slow", run: "true", tags: ["slow"] },
      { name: "e2e", run: "true", tags: ["e2e"] },
      { name: "test", run: "exit 1" },
    ]);
    const only = await execa(
      "bun",
      [CLI, "verify", "--dir", dir, "--json", "--only", "lint,types"],
      {
        reject: false,
      },
    );
    expect(only.exitCode).toBe(0);
    expect(JSON.parse(only.stdout).totals).toEqual({ passed: 2, failed: 0, skipped: 3 });
    const skip = await execa(
      "bun",
      [CLI, "verify", "--dir", dir, "--json", "--skip-tag", "slow,e2e", "--only", "slow,lint"],
      { reject: false },
    );
    expect(JSON.parse(skip.stdout).totals).toEqual({ passed: 1, failed: 0, skipped: 4 });
  });

  it("on SIGINT kills the running step and still runs teardown", async () => {
    const dir = project([
      { name: "hang", run: "sleep 30 & echo $! > sleep.pid; wait" },
      { name: "down", run: "touch torn-down", phase: "teardown" },
    ]);
    const child = execa("bun", [CLI, "verify", "--dir", dir], { reject: false });
    try {
      // The step is running once it has recorded its background pid.
      const pid = await readPid(join(dir, "sleep.pid"));
      child.kill("SIGINT");
      const res = await child;
      expect(res.exitCode).toBe(130);
      expect(existsSync(join(dir, "torn-down"))).toBe(true);
      await expectGone(pid);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("on SIGTERM exits 143 and reports the signal in --json", async () => {
    const dir = project([{ name: "hang", run: "sleep 30 & echo $! > sleep.pid; wait" }]);
    const child = execa("bun", [CLI, "verify", "--dir", dir, "--json"], { reject: false });
    try {
      const pid = await readPid(join(dir, "sleep.pid"));
      child.kill("SIGTERM");
      const res = await child;
      expect(res.exitCode).toBe(143);
      expect(JSON.parse(res.stdout)).toMatchObject({ interrupted: true, signal: "SIGTERM" });
      await expectGone(pid);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
