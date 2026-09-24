/** Pieces shared by `new` and `add`. */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { type GitState, INCOMING_DIR } from "./brief.js";
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
import { BRIEF_PATH, MANIFEST_PATH } from "./manifest.js";
import { println } from "./output.js";
import { assertInsideProject } from "./render.js";
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

/** The nearest directory at or above `path` that exists. */
function nearestExisting(path: string): string {
  return existsSync(path) || dirname(path) === path ? path : nearestExisting(dirname(path));
}

/**
 * How `new` will leave git in `dir`, probed before anything is written so the brief can say it:
 * "parent" when `dir` (or its nearest existing ancestor) is already inside another work tree,
 * "none" when git isn't installed, else "fresh" (ensureGitRepo will `git init` it).
 */
export function probeGit(dir: string): GitState {
  const probeDir = nearestExisting(dir);
  try {
    const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: probeDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // An empty target that is itself a repo (new allows a lone .git) is the project's own.
    if (!toplevel || (probeDir === dir && realpathSync(dir) === toplevel)) return { kind: "fresh" };
    return { kind: "parent", toplevel };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    return { kind: "fresh" };
  }
}

/** `git init` a "fresh" project. Returns a warning when git is missing or init fails. */
export function ensureGitRepo(dir: string, git: GitState): string | undefined {
  if (git.kind === "parent") return undefined;
  if (git.kind === "none") {
    return "git isn't installed, so the project wasn't initialized as a git repo; install git and run `git init` there";
  }
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });
    return undefined;
  } catch (err) {
    return `git init failed in ${dir}: ${(err as Error).message}`;
  }
}

/** Write `.openscaffold/BRIEF.md`, refusing to write through a symlink that leads outside `dir`. */
export function writeBrief(dir: string, text: string): string {
  const path = join(dir, BRIEF_PATH);
  assertInsideProject(dir, path);
  mkdirSync(dirname(path), { recursive: true });
  assertInsideProject(dir, path);
  writeFileSync(path, text);
  return path;
}

/**
 * Throw before anything is written when the manifest, brief, or incoming dir would land outside
 * `dir`. `.openscaffold` and its incoming dir must also not be symlinks, even to somewhere inside
 * the project: `add` lists the incoming dir's files for the agent to merge and tells it to delete
 * the dir afterwards, so a cloned repo that links it elsewhere could steer both.
 */
export function assertMetadataInside(dir: string): void {
  for (const rel of [MANIFEST_PATH, BRIEF_PATH, `${INCOMING_DIR}/x`]) {
    assertInsideProject(dir, join(dir, rel));
  }
  for (const rel of [dirname(INCOMING_DIR), INCOMING_DIR]) {
    let link = false;
    try {
      link = lstatSync(join(dir, rel)).isSymbolicLink();
    } catch {
      // Missing: nothing to check.
    }
    if (link) {
      throw new OpenScaffoldError(
        "render_incoming_blocked",
        `${join(dir, rel)} is a symlink`,
        `openscaffold keeps its files in a real ${rel}/ directory. Remove the symlink and rerun.`,
      );
    }
  }
}

/** Composed entries that aren't trusted, as "fragment x (./path)" with paths shown from `cwd`. */
export function untrustedEntries(plan: ComposedPlan, cwd: string): string[] {
  return [...(plan.stack ? [plan.stack] : []), ...plan.fragments]
    .filter((e) => !e.trusted)
    .map((e) => {
      const rel = relative(cwd, e.dir);
      return `${e.kind} ${e.id} (${rel.startsWith("..") ? e.dir : `./${rel}`})`;
    });
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
  ctx: {
    dir: string;
    plan: ComposedPlan;
    verifyCommand: string;
    configAgents: AgentId[];
    /** Directory whose ./.openscaffold project entries were loaded from. */
    registryDir: string;
  },
): Promise<HandoffResult> {
  const cwd = opts.cwd ?? process.cwd();
  const rel = relative(cwd, ctx.dir);
  const shownDir = rel === "" ? "." : rel.startsWith("..") ? ctx.dir : rel;
  const untrusted = untrustedEntries(ctx.plan, cwd);
  const decision = decideHandoff({
    env: opts.env ?? process.env,
    isTTY: opts.isTTY ?? Boolean(process.stdout.isTTY),
    json: opts.json,
    launch: opts.launch,
    preferred: opts.agent ? parseAgent(opts.agent, "--agent") : undefined,
    configAgents: ctx.configAgents,
    trusted: untrusted.length === 0,
    verifyCommand: ctx.verifyCommand,
    hasBinary: opts.hasTool,
  });
  const next = handoffMessage(decision, {
    dir: decision.kind === "inside-agent" ? ctx.dir : shownDir,
    briefPath:
      decision.kind === "inside-agent" ? join(ctx.dir, BRIEF_PATH) : join(shownDir, BRIEF_PATH),
    verifyCommand: ctx.verifyCommand,
    untrusted,
    untrustedFrom: ctx.registryDir,
  });
  if (opts.json) return { decision, next };
  const print = opts.print ?? println;
  print(next);
  if (decision.kind !== "launch") return { decision, next };
  const agentExit = await (opts.spawn ?? spawnAgent)(decision.bin, decision.args, ctx.dir);
  return { decision, next, agentExit };
}
