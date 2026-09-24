import { spawn } from "node:child_process";
import { toolOnPath } from "./compose.js";
import { AGENTS, type AgentId } from "./schema/index.js";

/**
 * Environment markers set by each coding agent for the commands it runs.
 * Sources (checked 2026-09):
 * - claude: CLAUDECODE=1 (Claude Code docs; also @vercel/detect-agent, which adds CLAUDE_CODE)
 * - codex: CODEX_SANDBOX, CODEX_CI, CODEX_THREAD_ID (@vercel/detect-agent; CODEX_SANDBOX in Codex docs)
 * - opencode: OPENCODE=1 (sst/opencode#1775), OPENCODE_CLIENT (@vercel/detect-agent)
 * - cursor: CURSOR_AGENT (Cursor terminal docs), CURSOR_EXTENSION_HOST_ROLE=agent-exec
 *   (@vercel/detect-agent). CURSOR_TRACE_ID is deliberately not used: Cursor's integrated
 *   terminal sets it for humans too.
 * - AI_AGENT: cross-agent convention (value names the agent, e.g. "claude-code_2-1_agent").
 */
const MARKERS: { agent: AgentId; test: (env: NodeJS.ProcessEnv) => boolean }[] = [
  { agent: "claude", test: (e) => Boolean(e.CLAUDECODE || e.CLAUDE_CODE) },
  { agent: "codex", test: (e) => Boolean(e.CODEX_SANDBOX || e.CODEX_CI || e.CODEX_THREAD_ID) },
  { agent: "opencode", test: (e) => Boolean(e.OPENCODE || e.OPENCODE_CLIENT) },
  {
    agent: "cursor",
    test: (e) => Boolean(e.CURSOR_AGENT) || e.CURSOR_EXTENSION_HOST_ROLE === "agent-exec",
  },
];

export type DetectedAgent = AgentId | "other";

/**
 * Which coding agent is running this process: one of AGENTS, "other" when only the generic
 * AI_AGENT marker names something else, or undefined when no agent is detected.
 */
export function detectAgent(env: NodeJS.ProcessEnv = process.env): DetectedAgent | undefined {
  for (const { agent, test } of MARKERS) if (test(env)) return agent;
  const generic = env.AI_AGENT?.toLowerCase();
  if (generic) {
    if (generic.startsWith("claude")) return "claude";
    if (generic.startsWith("cursor")) return "cursor";
    return AGENTS.find((a) => generic.startsWith(a)) ?? "other";
  }
  return undefined;
}

/** Executables to look for, in order. Cursor's CLI is also installed as `agent`, too generic to probe. */
export const AGENT_BINARIES: Record<AgentId, string[]> = {
  claude: ["claude"],
  codex: ["codex"],
  opencode: ["opencode"],
  cursor: ["cursor-agent"],
};

/**
 * Arguments that start each agent's interactive session with `prompt` already submitted.
 * claude "<prompt>", codex "<prompt>", cursor-agent "<prompt>" (positional initial prompt);
 * opencode takes it via --prompt.
 */
export function launchArgs(agent: AgentId, prompt: string): string[] {
  return agent === "opencode" ? ["--prompt", prompt] : [prompt];
}

/** The prompt given to a launched (or pasted-into) agent. Paths are relative to the project root. */
export function agentPrompt(verifyCommand: string): string {
  return `Read .openscaffold/BRIEF.md and carry it out. It's your full task for this project; you're done when \`${verifyCommand}\` passes.`;
}

export type HandoffDecision =
  | { kind: "inside-agent"; agent: DetectedAgent }
  | { kind: "launch"; agent: AgentId; bin: string; args: string[] }
  | { kind: "print"; reason: string };

export interface HandoffOptions {
  env?: NodeJS.ProcessEnv;
  isTTY: boolean;
  json?: boolean;
  /** false when --no-launch was passed. */
  launch?: boolean;
  /** --agent */
  preferred?: AgentId;
  /** Agent order from user config. */
  configAgents?: AgentId[];
  /** Every composed entry is trusted. */
  trusted: boolean;
  verifyCommand: string;
  hasBinary?: (bin: string) => boolean;
}

/** Decide how to hand the brief to an agent. Pure apart from the PATH lookup. */
export function decideHandoff(opts: HandoffOptions): HandoffDecision {
  const inside = detectAgent(opts.env ?? process.env);
  if (inside) return { kind: "inside-agent", agent: inside };
  if (opts.json) return { kind: "print", reason: "--json never launches an agent" };
  if (opts.launch === false) return { kind: "print", reason: "--no-launch" };
  if (!opts.isTTY) return { kind: "print", reason: "stdout is not a terminal" };
  if (!opts.trusted) {
    return {
      kind: "print",
      reason: "the plan includes untrusted entries, so nothing is auto-launched",
    };
  }
  const hasBinary = opts.hasBinary ?? toolOnPath;
  const order = opts.preferred
    ? [opts.preferred]
    : [
        ...new Set<AgentId>([
          ...(opts.configAgents ?? []),
          "claude",
          "codex",
          "opencode",
          "cursor",
        ]),
      ];
  for (const agent of order) {
    const bin = AGENT_BINARIES[agent].find(hasBinary);
    if (bin) {
      return {
        kind: "launch",
        agent,
        bin,
        args: launchArgs(agent, agentPrompt(opts.verifyCommand)),
      };
    }
  }
  return {
    kind: "print",
    reason: opts.preferred
      ? `${AGENT_BINARIES[opts.preferred].join(" / ")} isn't on PATH`
      : "no agent CLI (claude, codex, opencode, cursor-agent) found on PATH",
  };
}

function quote(s: string): string {
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Text telling the reader what to do next. `dir` is how to reach the project from here. */
export function handoffMessage(
  decision: HandoffDecision,
  ctx: { dir: string; briefPath: string; verifyCommand: string },
): string {
  const prompt = agentPrompt(ctx.verifyCommand);
  switch (decision.kind) {
    case "inside-agent":
      return [
        `NEXT STEP FOR THE AGENT: read ${ctx.briefPath} now and carry it out, working in ${ctx.dir}.`,
        `It is the complete task: set up the project, then loop on \`${ctx.verifyCommand}\` (run from ${ctx.dir}) until it passes. Don't stop here to report back; the brief says when to ask the user something.`,
      ].join("\n");
    case "launch":
      return `Launching ${decision.bin} in ${ctx.dir} to build it from the brief...`;
    case "print":
      return [
        `Next: open ${ctx.dir === "." ? "this directory" : ctx.dir} in your coding agent and give it this prompt:`,
        "",
        `  ${prompt}`,
        "",
        `For example: ${ctx.dir === "." ? "" : `cd ${ctx.dir} && `}claude ${quote(prompt)}`,
        `The brief is at ${ctx.briefPath}.`,
      ].join("\n");
  }
}

/** Spawn an interactive agent. Resolves with its exit code. Injected in tests. */
export type SpawnAgent = (bin: string, args: string[], cwd: string) => Promise<number>;

export const spawnAgent: SpawnAgent = (bin, args, cwd) =>
  new Promise((resolveExit, reject) => {
    const child = spawn(bin, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
