/** Pieces shared by `new` and `add`. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { OpenScaffoldError } from "./errors.js";
import {
  type DetectedAgent,
  decideHandoff,
  detectAgent,
  type HandoffDecision,
  handoffMessage,
  type SpawnAgent,
  spawnAgent,
} from "./handoff.js";
import { BRIEF_PATH } from "./manifest.js";
import { println } from "./output.js";
import { AGENTS, type AgentId } from "./schema/index.js";
import type { ComposedPlan, OwnedVerifyStep } from "./types.js";

/** Options every scaffolding command accepts, plus test injection points. */
export interface CommonRunOptions {
  agents?: string[];
  agent?: string;
  /** false = --no-launch */
  launch?: boolean;
  yes?: boolean;
  offline?: boolean;
  json?: boolean;
  /** Where the command was run from (default process.cwd()). */
  cwd?: string;
  home?: string;
  bundledDir?: string;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  spawn?: SpawnAgent;
  /** PATH lookup for both stack tools and agent binaries. */
  hasTool?: (tool: string) => boolean;
  gitUserName?: () => string | undefined;
  now?: Date;
  /** Human output sinks (default stdout/stderr). */
  print?: (line: string) => void;
  warn?: (line: string) => void;
}

/** Split repeatable, comma-separated option values: ["a,b", "c"] -> ["a", "b", "c"]. */
export function splitList(values: string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Commander accumulator for repeatable comma-separated options. */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, ...splitList([value])];
}

export function parseAgent(name: string, flag: string): AgentId {
  if ((AGENTS as readonly string[]).includes(name)) return name as AgentId;
  throw new OpenScaffoldError(
    "bad_option",
    `${flag}: unknown agent "${name}"`,
    `Use one of: ${AGENTS.join(", ")}.`,
  );
}

/**
 * Target agents: --agents if given, else the detected agent plus config agents (plus `extra`,
 * e.g. agents already in a manifest), else all of them.
 */
export function resolveAgents(
  flag: string[] | undefined,
  detected: DetectedAgent | undefined,
  configAgents: AgentId[],
  extra: AgentId[] = [],
): AgentId[] {
  const requested = splitList(flag);
  if (requested.length) return [...new Set(requested.map((a) => parseAgent(a, "--agents")))];
  const found = new Set<AgentId>(extra);
  if (detected && detected !== "other") found.add(detected);
  for (const a of configAgents) found.add(a);
  return found.size ? AGENTS.filter((a) => found.has(a)) : [...AGENTS];
}

export function detected(opts: CommonRunOptions): DetectedAgent | undefined {
  return detectAgent(opts.env ?? process.env);
}

/** Composed verify steps without `owner`, as the manifest stores them. */
export function stripOwner(steps: OwnedVerifyStep[]) {
  return steps.map(({ owner: _owner, ...step }) => step);
}

/** `git init` unless `dir` is already inside a work tree. Returns a warning when git is missing. */
export function ensureGitRepo(dir: string): string | undefined {
  try {
    const inside = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (inside === "true") return undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "git isn't installed, so the project wasn't initialized as a git repo; install git and run `git init` there";
    }
    // Not a work tree: fall through to init.
  }
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });
    return undefined;
  } catch (err) {
    return `git init failed in ${dir}: ${(err as Error).message}`;
  }
}

export function writeBrief(dir: string, text: string): string {
  const path = join(dir, BRIEF_PATH);
  mkdirSync(join(dir, ".openscaffold"), { recursive: true });
  writeFileSync(path, text);
  return path;
}

export function allTrusted(plan: ComposedPlan): boolean {
  return [...(plan.stack ? [plan.stack] : []), ...plan.fragments].every((e) => e.trusted);
}

export interface HandoffResult {
  decision: HandoffDecision;
  next: string;
  /** Exit code of a launched agent. */
  agentExit?: number;
}

/** Decide, print, and (maybe) launch. In --json mode nothing is printed or launched. */
export async function runHandoff(
  opts: CommonRunOptions,
  ctx: { dir: string; plan: ComposedPlan; verifyCommand: string; configAgents: AgentId[] },
): Promise<HandoffResult> {
  const cwd = opts.cwd ?? process.cwd();
  const rel = relative(cwd, ctx.dir);
  const shownDir = rel === "" ? "." : rel.startsWith("..") ? ctx.dir : rel;
  const decision = decideHandoff({
    env: opts.env ?? process.env,
    isTTY: opts.isTTY ?? Boolean(process.stdout.isTTY),
    json: opts.json,
    launch: opts.launch,
    preferred: opts.agent ? parseAgent(opts.agent, "--agent") : undefined,
    configAgents: ctx.configAgents,
    trusted: allTrusted(ctx.plan),
    verifyCommand: ctx.verifyCommand,
    hasBinary: opts.hasTool,
  });
  const next = handoffMessage(decision, {
    dir: decision.kind === "inside-agent" ? ctx.dir : shownDir,
    briefPath:
      decision.kind === "inside-agent" ? join(ctx.dir, BRIEF_PATH) : join(shownDir, BRIEF_PATH),
    verifyCommand: ctx.verifyCommand,
  });
  if (opts.json) return { decision, next };
  const print = opts.print ?? println;
  print(next);
  if (decision.kind !== "launch") return { decision, next };
  const agentExit = await (opts.spawn ?? spawnAgent)(decision.bin, decision.args, ctx.dir);
  return { decision, next, agentExit };
}
