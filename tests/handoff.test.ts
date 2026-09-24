import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import {
  agentPrompt,
  decideHandoff,
  detectAgent,
  type HandoffOptions,
  handoffMessage,
  launchArgs,
} from "../src/handoff.js";

const HANDOFF = resolve(import.meta.dirname, "../src/handoff.ts");

describe("detectAgent", () => {
  it.each([
    [{ CLAUDECODE: "1" }, "claude"],
    [{ CODEX_SANDBOX: "seatbelt" }, "codex"],
    [{ CODEX_THREAD_ID: "t1" }, "codex"],
    [{ OPENCODE: "1" }, "opencode"],
    [{ OPENCODE_CLIENT: "cli" }, "opencode"],
    [{ CURSOR_AGENT: "1" }, "cursor"],
    [{ CURSOR_EXTENSION_HOST_ROLE: "agent-exec" }, "cursor"],
    [{ AI_AGENT: "claude-code_2-1_agent" }, "claude"],
    [{ AI_AGENT: "codex" }, "codex"],
    [{ AI_AGENT: "some-new-agent" }, "other"],
  ])("%o -> %s", (env, agent) => {
    expect(detectAgent(env)).toBe(agent);
  });

  it("returns undefined for a plain shell, including Cursor's integrated terminal", () => {
    expect(detectAgent({ PATH: "/bin", TERM: "xterm" })).toBeUndefined();
    expect(detectAgent({ CURSOR_TRACE_ID: "abc" })).toBeUndefined();
  });
});

describe("launchArgs", () => {
  it("passes the prompt positionally, except opencode's --prompt", () => {
    expect(launchArgs("claude", "go")).toEqual(["go"]);
    expect(launchArgs("codex", "go")).toEqual(["go"]);
    expect(launchArgs("cursor", "go")).toEqual(["go"]);
    expect(launchArgs("opencode", "go")).toEqual(["--prompt", "go"]);
  });
});

describe("decideHandoff", () => {
  const base: HandoffOptions = {
    env: {},
    isTTY: true,
    trusted: true,
    verifyCommand: "npx openscaffold verify",
    hasBinary: (bin) => bin === "claude" || bin === "opencode",
  };

  it("hands back to the calling agent when inside one, even with --json or --no-launch", () => {
    for (const extra of [{}, { json: true }, { launch: false }]) {
      expect(decideHandoff({ ...base, ...extra, env: { CLAUDECODE: "1" } })).toEqual({
        kind: "inside-agent",
        agent: "claude",
      });
    }
  });

  it("launches the first agent on PATH from a TTY", () => {
    expect(decideHandoff(base)).toEqual({
      kind: "launch",
      agent: "claude",
      bin: "claude",
      args: [agentPrompt("npx openscaffold verify")],
    });
  });

  it("honors --agent, then config order", () => {
    expect(decideHandoff({ ...base, preferred: "opencode" })).toMatchObject({
      kind: "launch",
      bin: "opencode",
      args: ["--prompt", expect.stringContaining("BRIEF.md")],
    });
    expect(decideHandoff({ ...base, configAgents: ["codex", "opencode"] })).toMatchObject({
      kind: "launch",
      agent: "opencode",
    });
    expect(decideHandoff({ ...base, preferred: "codex" })).toMatchObject({
      kind: "print",
      reason: expect.stringContaining("codex"),
    });
  });

  it.each([
    [{ json: true }, "--json"],
    [{ launch: false }, "--no-launch"],
    [{ isTTY: false }, "terminal"],
    [{ trusted: false }, "untrusted"],
    [{ hasBinary: () => false }, "no agent CLI"],
  ] as [Partial<HandoffOptions>, string][])("prints instructions when %o", (extra, reason) => {
    const decision = decideHandoff({ ...base, ...extra });
    expect(decision.kind).toBe("print");
    expect(decision.kind === "print" && decision.reason).toContain(reason);
  });
});

describe("handoffMessage", () => {
  const ctx = {
    dir: "demo",
    briefPath: "demo/.openscaffold/BRIEF.md",
    verifyCommand: "npx openscaffold verify",
  };

  it("tells a calling agent to read and execute the brief now", () => {
    const text = handoffMessage({ kind: "inside-agent", agent: "claude" }, ctx);
    expect(text).toContain("read demo/.openscaffold/BRIEF.md now");
    expect(text).toContain("npx openscaffold verify");
  });

  it("gives a human a copy-pasteable prompt", () => {
    const text = handoffMessage({ kind: "print", reason: "--no-launch" }, ctx);
    expect(text).toContain(agentPrompt(ctx.verifyCommand));
    expect(text).toContain("cd demo && claude ");
  });

  it("uses the preferred agent's binary and arguments in the example, and quotes the dir", () => {
    const decision = decideHandoff({
      env: {},
      isTTY: true,
      trusted: true,
      launch: false,
      preferred: "opencode",
      verifyCommand: ctx.verifyCommand,
      hasBinary: () => true,
    });
    const text = handoffMessage(decision, { ...ctx, dir: "my demo" });
    expect(text).toContain('cd "my demo" && opencode --prompt ');
    const fromConfig = decideHandoff({
      env: {},
      isTTY: false,
      trusted: true,
      configAgents: ["cursor"],
      verifyCommand: ctx.verifyCommand,
    });
    expect(handoffMessage(fromConfig, ctx)).toContain("cd demo && cursor-agent ");
  });
});

describe("spawnAgent", () => {
  it("survives SIGINT while the agent runs and forwards SIGTERM to it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "os-handoff-"));
    try {
      const script = join(dir, "run.ts");
      writeFileSync(
        script,
        `import { writeFileSync } from "node:fs";
import { spawnAgent } from ${JSON.stringify(HANDOFF)};
const before = process.listenerCount("SIGINT");
const p = spawnAgent("sh", ["-c", "echo $$ > child.pid; exec sleep 30"], ${JSON.stringify(dir)});
setTimeout(() => writeFileSync("ready", ""), 300);
const code = await p;
console.log(JSON.stringify({ code, leaked: process.listenerCount("SIGINT") - before }));
`,
      );
      const child = execa("bun", [script], { cwd: dir, reject: false });
      let exited = false;
      void child.then(() => {
        exited = true;
      });
      const exists = (f: string) => {
        try {
          readFileSync(join(dir, f));
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 100 && !exists("ready"); i++) await new Promise((r) => setTimeout(r, 50));
      const childPid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
      child.kill("SIGINT");
      await new Promise((r) => setTimeout(r, 300));
      expect(exited).toBe(false);
      expect(() => process.kill(childPid, 0)).not.toThrow();
      child.kill("SIGTERM");
      const res = await child;
      expect(JSON.parse(res.stdout)).toEqual({ code: 143, leaked: 0 });
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
