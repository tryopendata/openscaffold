import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { buildBrief, cliInvocation } from "../brief.js";
import { compose } from "../compose.js";
import { loadUserConfig } from "../config.js";
import { OpenScaffoldError } from "../errors.js";
import type { HandoffDecision } from "../handoff.js";
import { hashVerify, MANIFEST_PATH, writeManifest } from "../manifest.js";
import { printJson, println, warn } from "../output.js";
import { loadRegistry } from "../registry/index.js";
import { renderFiles } from "../render.js";
import {
  type CommonRunOptions,
  collect,
  detected,
  ensureGitRepo,
  resolveAgents,
  runHandoff,
  splitList,
  stripOwner,
  writeBrief,
} from "../scaffold.js";
import { SCHEMA_VERSION } from "../schema/index.js";
import type { ComposedPlan } from "../types.js";
import { buildVars, slugify } from "../vars.js";
import { VERSION } from "../version.js";

export interface NewOptions extends CommonRunOptions {
  stack: string;
  dir?: string;
  with?: string[];
  without?: string[];
  sandbox?: boolean;
  name?: string;
  scope?: string;
  author?: string;
  /** Override how the brief tells the agent to call this CLI. */
  cli?: string;
}

export interface NewResult {
  dir: string;
  stack: string;
  fragments: string[];
  agents: string[];
  preset: "default" | "sandbox";
  written: string[];
  skipped: string[];
  warnings: string[];
  missingTools: { owner: string; tool: string }[];
  brief: string;
  verifyCommand: string;
  next: string;
  handoff: HandoffDecision;
  agentExit?: number;
}

const IGNORED_IN_TARGET = new Set([".git", ".DS_Store"]);

/** Files under `dir` (relative, "/"-separated), skipping IGNORED_IN_TARGET names. */
function listTarget(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_IN_TARGET.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listTarget(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Refuse a non-empty target. A directory with no manifest that holds `.openscaffold/` or only
 * files this plan would write is most likely a `new` that stopped partway, so the hint says to
 * delete it and start over rather than to run `add` on it.
 */
function assertEmptyTarget(dir: string, plan: ComposedPlan): void {
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) {
    throw new OpenScaffoldError("target_not_dir", `${dir} exists and isn't a directory`);
  }
  const extra = readdirSync(dir).filter((n) => !IGNORED_IN_TARGET.has(n));
  if (extra.length === 0) return;
  const message = `${dir} isn't empty (${extra.slice(0, 5).join(", ")}${extra.length > 5 ? ", ..." : ""})`;
  const planned = new Set(plan.files.map((f) => f.dest));
  const halfFinished =
    !existsSync(join(dir, MANIFEST_PATH)) &&
    (extra.includes(".openscaffold") || listTarget(dir).every((f) => planned.has(f)));
  throw new OpenScaffoldError(
    "target_not_empty",
    message,
    halfFinished
      ? `This looks like an earlier \`openscaffold new\` that didn't finish (no ${MANIFEST_PATH}). If nothing in it is yours, delete ${dir} and re-run \`openscaffold new\`; otherwise pick a new directory.`
      : `\`new\` only scaffolds into an empty directory. For an existing repo, run \`openscaffold add <fragment...> --dir ${dir}\`; otherwise pick a new directory.`,
  );
}

/** `openscaffold new`: scaffold a stack into an empty directory and hand off to an agent. */
export async function runNew(opts: NewOptions): Promise<NewResult> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home;
  const warnLine = opts.warn ?? warn;
  const print = opts.print ?? println;

  const config = loadUserConfig(home);
  const registry = await loadRegistry({
    cwd,
    home,
    offline: opts.offline,
    bundledDir: opts.bundledDir,
  });
  const stack = registry.stack(opts.stack);
  const dir = resolve(cwd, opts.dir ?? (opts.name ? slugify(opts.name) : stack.id));

  const sandbox = Boolean(opts.sandbox) || config.preset === "sandbox";
  const agents = resolveAgents(opts.agents, detected(opts), config.agents);
  const plan = compose(
    registry,
    {
      stackId: stack.id,
      with: splitList(opts.with),
      without: splitList(opts.without),
      sandbox,
      agents,
      always: config.always,
    },
    { hasTool: opts.hasTool },
  );
  assertEmptyTarget(dir, plan);
  const warnings = [...registry.warnings, ...plan.warnings];
  if (!opts.json) for (const w of warnings) warnLine(w);

  const vars = buildVars({
    dir,
    name: opts.name,
    scope: opts.scope,
    author: opts.author,
    config,
    gitUserName: opts.gitUserName,
    now: opts.now,
  });

  mkdirSync(dir, { recursive: true });
  const { written, skipped } = renderFiles(plan.files, dir, vars);

  const gitWarning = ensureGitRepo(dir);
  if (gitWarning) {
    warnings.push(gitWarning);
    if (!opts.json) warnLine(gitWarning);
  }

  const verify = stripOwner(plan.verify);
  const now = (opts.now ?? new Date()).toISOString();
  writeManifest(dir, {
    openscaffold: VERSION,
    schema_version: SCHEMA_VERSION,
    stack: stack.id,
    preset: plan.preset,
    agents: plan.agents,
    fragments: plan.fragments.map((f) => f.id),
    vars,
    env: plan.env,
    verify,
    verify_hash: hashVerify(verify),
    created: now,
    updated: now,
  });

  const cli = opts.cli ?? cliInvocation();
  const verifyCommand = `${cli} verify`;
  const brief = writeBrief(
    dir,
    buildBrief({
      mode: "new",
      vars,
      plan,
      written,
      mergeNeeded: [],
      yes: Boolean(opts.yes) || sandbox,
      verify,
      env: plan.env,
      cli,
    }),
  );

  if (!opts.json) {
    const frags = plan.fragments.map((f) => f.id);
    print(
      `Scaffolded ${stack.id}${frags.length ? ` + ${frags.join(", ")}` : ""} into ${dir} (${written.length} files, preset ${plan.preset}, agents ${plan.agents.join(", ")}).`,
    );
    print(`Brief: ${brief}`);
    print("");
  }
  const handoff = await runHandoff(opts, { dir, plan, verifyCommand, configAgents: config.agents });

  const result: NewResult = {
    dir,
    stack: stack.id,
    fragments: plan.fragments.map((f) => f.id),
    agents: plan.agents,
    preset: plan.preset,
    written,
    skipped,
    warnings,
    missingTools: plan.missingTools,
    brief,
    verifyCommand,
    next: handoff.next,
    handoff: handoff.decision,
    agentExit: handoff.agentExit,
  };
  if (opts.json) {
    const { handoff: _h, agentExit: _a, ...json } = result;
    printJson(json);
  }
  return result;
}

interface NewFlags {
  with?: string[];
  without?: string[];
  sandbox?: boolean;
  yes?: boolean;
  agents?: string[];
  agent?: string;
  launch?: boolean;
  name?: string;
  scope?: string;
  author?: string;
  offline?: boolean;
  json?: boolean;
}

export function register(program: Command): void {
  program
    .command("new")
    .description(
      "Scaffold a stack into a new directory, write .openscaffold/BRIEF.md, and hand off to a coding agent",
    )
    .argument("<stack>", "stack id (see `openscaffold list --kind stack`)")
    .argument("[dir]", "target directory, must be empty (default: ./<name or stack id>)")
    .option("--with <ids>", "add fragments (comma-separated, repeatable)", collect)
    .option("--without <ids>", "drop default fragments (comma-separated, repeatable)", collect)
    .option("--sandbox", "local-only preset: implies --yes, drops deploy/release fragments")
    .option("--yes", "use stated defaults; the agent won't ask the user to confirm decisions")
    .option("--agents <list>", "target agents: claude,codex,opencode,cursor", collect)
    .option("--agent <name>", "agent CLI to launch when not already inside one")
    .option("--no-launch", "never launch an agent; just print the next step")
    .option("--name <name>", "project name (default: directory name)")
    .option("--scope <scope>", "package scope (default: config package_scope, else the slug)")
    .option("--author <author>", "author (default: config author, else git user.name)")
    .option("--offline", "don't fetch the registry; use cached and bundled entries")
    .option("--json", "print the result as JSON (never launches)")
    .action(async (stack: string, dir: string | undefined, flags: NewFlags) => {
      const result = await runNew({ ...flags, stack, dir });
      if (result.agentExit) process.exitCode = result.agentExit;
    });
}
