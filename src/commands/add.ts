import { existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { buildBrief, cliInvocation, INCOMING_DIR } from "../brief.js";
import { compose } from "../compose.js";
import { loadUserConfig } from "../config.js";
import { OpenScaffoldError } from "../errors.js";
import type { HandoffDecision } from "../handoff.js";
import { hashVerify, readManifest, writeManifest } from "../manifest.js";
import { printJson } from "../output.js";
import { loadRegistry } from "../registry/index.js";
import { renderFiles } from "../render.js";
import {
  type CommonRunOptions,
  collect,
  detected,
  resolveAgents,
  runHandoff,
  splitList,
  stripOwner,
  writeBrief,
} from "../scaffold.js";
import { type Manifest, SCHEMA_VERSION, TEMPLATE_VARS } from "../schema/index.js";
import type { ComposedPlan } from "../types.js";
import { buildVars, inferProjectName } from "../vars.js";
import { VERSION } from "../version.js";

export interface AddOptions extends CommonRunOptions {
  fragments: string[];
  /** Project directory (default cwd). */
  dir?: string;
  cli?: string;
}

export interface AddResult {
  dir: string;
  stack: string | null;
  added: string[];
  fragments: string[];
  agents: string[];
  written: string[];
  mergeNeeded: string[];
  warnings: string[];
  missingTools: { owner: string; tool: string }[];
  manifestCreated: boolean;
  brief: string;
  verifyCommand: string;
  next: string;
  handoff: HandoffDecision;
  agentExit?: number;
}

/** Keep only what the newly added fragments contribute (compose re-emits the stack's own parts). */
function onlyNewFragments(plan: ComposedPlan): ComposedPlan {
  const ids = new Set(plan.fragments.map((f) => f.id));
  const stackId = plan.stack?.id;
  return {
    ...plan,
    files: plan.files.filter((f) => ids.has(f.owner)),
    verify: plan.verify.filter((s) => ids.has(s.owner)),
    env: Object.fromEntries(
      Object.entries(plan.env).filter(([k]) => plan.fragments.some((f) => k in f.meta.env)),
    ),
    decisions: plan.decisions.filter((d) => [...ids].some((id) => d.startsWith(`${id}: `))),
    missingTools: plan.missingTools.filter((t) => ids.has(t.owner)),
    warnings: plan.warnings.filter((w) => !stackId || !w.startsWith(`${stackId} needs `)),
  };
}

/** `openscaffold add`: apply fragments to an existing project and hand off to an agent. */
export async function runAdd(opts: AddOptions): Promise<AddResult> {
  const cwd = opts.cwd ?? process.cwd();
  const dir = resolve(cwd, opts.dir ?? ".");
  const warnLine = opts.warn ?? ((l: string) => process.stderr.write(`warning: ${l}\n`));
  const print = opts.print ?? ((l: string) => process.stdout.write(`${l}\n`));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new OpenScaffoldError(
      "target_missing",
      `${dir} isn't a directory`,
      "Pass --dir <existing project>, or use `openscaffold new <stack> <dir>` to start a new one.",
    );
  }
  const requested = splitList(opts.fragments);
  if (requested.length === 0) {
    throw new OpenScaffoldError(
      "bad_option",
      "no fragments given",
      "Run `openscaffold list --kind fragment` and pass one or more ids.",
    );
  }

  const config = loadUserConfig(opts.home);
  const registry = await loadRegistry({
    cwd: dir,
    home: opts.home,
    offline: opts.offline,
    bundledDir: opts.bundledDir,
  });
  const manifest = readManifest(dir);
  const warnings = [...registry.warnings];

  let stackId = manifest?.stack ?? undefined;
  if (stackId && !registry.get("stack", stackId)) {
    warnings.push(
      `the manifest's stack "${stackId}" isn't in any registry; fragments are applied without stack matching`,
    );
    stackId = undefined;
  }
  const agents = resolveAgents(opts.agents, detected(opts), config.agents, manifest?.agents ?? []);
  const composed = compose(
    registry,
    {
      stackId,
      with: requested,
      without: [],
      sandbox: manifest?.preset === "sandbox",
      agents,
      always: [],
      existing: manifest?.fragments ?? [],
    },
    { hasTool: opts.hasTool },
  );
  const plan = onlyNewFragments(composed);
  warnings.push(...plan.warnings);
  if (plan.fragments.length === 0) {
    throw new OpenScaffoldError(
      "nothing_to_add",
      `${requested.join(", ")} ${requested.length === 1 ? "is" : "are"} already applied to ${dir}`,
      "See `.openscaffold/manifest.yaml` for what's applied; `openscaffold list --kind fragment` for others.",
    );
  }

  const existingSteps = manifest?.verify ?? [];
  const newSteps = stripOwner(plan.verify);
  for (const step of newSteps) {
    if (existingSteps.some((s) => s.name === step.name)) {
      throw new OpenScaffoldError(
        "compose_error",
        `verify step "${step.name}" from ${plan.verify.find((s) => s.name === step.name)?.owner} already exists in the manifest`,
        "Rename the step in the fragment or remove the existing one from the manifest.",
      );
    }
  }
  const env = { ...(manifest?.env ?? {}) };
  for (const [k, v] of Object.entries(plan.env)) {
    if (k in env && env[k] !== v) {
      warnings.push(
        `env ${k} stays "${env[k]}" from the manifest (the fragment's default is "${v}")`,
      );
      continue;
    }
    env[k] = v;
  }
  if (!opts.json) for (const w of warnings) warnLine(w);

  const inferred = buildVars({
    dir,
    name: inferProjectName(dir),
    config,
    gitUserName: opts.gitUserName,
    now: opts.now,
  });
  const vars = { ...inferred, ...(manifest?.vars ?? {}) };
  for (const key of Object.keys(vars)) if (!TEMPLATE_VARS.includes(key)) delete vars[key];
  const incoming = join(dir, INCOMING_DIR);
  rmSync(incoming, { recursive: true, force: true });
  const { written, skipped } = renderFiles(plan.files, dir, vars, { incomingDir: incoming });

  const now = (opts.now ?? new Date()).toISOString();
  const verify = [...existingSteps, ...newSteps];
  const next: Manifest = {
    openscaffold: VERSION,
    schema_version: SCHEMA_VERSION,
    stack: stackId ?? manifest?.stack ?? null,
    preset: manifest?.preset ?? config.preset,
    agents: [...new Set([...(manifest?.agents ?? []), ...plan.agents])],
    fragments: [...(manifest?.fragments ?? []), ...plan.fragments.map((f) => f.id)],
    vars: { ...(manifest?.vars ?? {}), ...vars },
    env,
    verify,
    verify_hash: hashVerify(verify),
    created: manifest?.created ?? now,
    updated: now,
  };
  writeManifest(dir, next);

  const cli = opts.cli ?? cliInvocation();
  const verifyCommand = `${cli} verify`;
  const brief = writeBrief(
    dir,
    buildBrief({
      mode: "add",
      vars,
      plan,
      existingFragments: manifest?.fragments ?? [],
      written,
      mergeNeeded: skipped,
      yes: Boolean(opts.yes) || next.preset === "sandbox",
      verify,
      env,
      cli,
    }),
  );

  if (!opts.json) {
    print(
      `Added ${plan.fragments.map((f) => f.id).join(", ")} to ${dir} (${written.length} files written${
        skipped.length ? `, ${skipped.length} already existed and need merging` : ""
      }).`,
    );
    print(`Brief: ${brief}`);
    print("");
  }
  const handoff = await runHandoff(opts, { dir, plan, verifyCommand, configAgents: config.agents });

  const result: AddResult = {
    dir,
    stack: next.stack,
    added: plan.fragments.map((f) => f.id),
    fragments: next.fragments,
    agents: next.agents,
    written,
    mergeNeeded: skipped,
    warnings,
    missingTools: plan.missingTools,
    manifestCreated: manifest === undefined,
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

interface AddFlags {
  dir: string;
  agents?: string[];
  agent?: string;
  launch?: boolean;
  yes?: boolean;
  offline?: boolean;
  json?: boolean;
}

export function register(program: Command): void {
  program
    .command("add")
    .description(
      "Apply fragments to an existing project (never overwrites files), write .openscaffold/BRIEF.md, and hand off to a coding agent",
    )
    .argument("<fragments...>", "fragment ids (see `openscaffold list --kind fragment`)")
    .option("--dir <path>", "project directory", ".")
    .option("--agents <list>", "target agents: claude,codex,opencode,cursor", collect)
    .option("--agent <name>", "agent CLI to launch when not already inside one")
    .option("--no-launch", "never launch an agent; just print the next step")
    .option("--yes", "use stated defaults; the agent won't ask the user to confirm decisions")
    .option("--offline", "don't fetch the registry; use cached and bundled entries")
    .option("--json", "print the result as JSON (never launches)")
    .action(async (fragments: string[], flags: AddFlags) => {
      const result = await runAdd({ ...flags, fragments });
      if (result.agentExit) process.exitCode = result.agentExit;
    });
}
