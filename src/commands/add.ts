import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { buildBrief, cliInvocation, INCOMING_DIR } from "../brief.js";
import { compose } from "../compose.js";
import { loadUserConfig } from "../config.js";
import { OpenScaffoldError } from "../errors.js";
import type { HandoffDecision } from "../handoff.js";
import { hashVerify, MANIFEST_PATH, readManifest, writeManifest } from "../manifest.js";
import { printJson, println, warn } from "../output.js";
import { loadRegistry } from "../registry/index.js";
import { planRender } from "../render.js";
import {
  assertMetadataInside,
  type CommonRunOptions,
  collect,
  detected,
  resolveAgents,
  runHandoff,
  splitList,
  stripOwner,
  untrustedEntries,
  writeBrief,
} from "../scaffold.js";
import { type Manifest, ManifestSchema, SCHEMA_VERSION, TEMPLATE_VARS } from "../schema/index.js";
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

/**
 * Regular files under `dir`, relative to it and "/"-separated. Empty when `dir` doesn't exist.
 * Symlinks are skipped, not followed: the brief would otherwise send the agent to merge
 * whatever they point at.
 */
function listFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** The project path a parked copy belongs to: `dest` for `dest` or a numbered `dest.<n>`. */
function parkedDest(file: string, parked: string[]): string {
  const m = /^(.+)\.(\d+)$/.exec(file);
  return m?.[1] && parked.includes(m[1]) ? m[1] : file;
}

/** `openscaffold add`: apply fragments to an existing project and hand off to an agent. */
export async function runAdd(opts: AddOptions): Promise<AddResult> {
  const cwd = opts.cwd ?? process.cwd();
  const dir = resolve(cwd, opts.dir ?? ".");
  const warnLine = opts.warn ?? warn;
  const print = opts.print ?? println;
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
  const preset = manifest?.preset ?? config.preset;

  let stackId = manifest?.stack ?? undefined;
  if (stackId && !registry.get("stack", stackId)) {
    warnings.push(
      `the manifest's stack "${stackId}" isn't in any registry; fragments are applied without stack matching`,
    );
    stackId = undefined;
  }
  const agents = resolveAgents(opts.agents, detected(opts), config.agents, manifest?.agents ?? []);
  const plan = compose(
    registry,
    {
      stackId,
      mode: "add",
      with: requested,
      without: [],
      sandbox: preset === "sandbox",
      agents,
      always: [],
      existing: manifest?.fragments ?? [],
    },
    { hasTool: opts.hasTool },
  );
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
  // A manifest whose steps no longer match their hash was edited by hand. Warn like `verify`
  // does, and keep verify_hash as it was: re-hashing here would bless the edit. The appended
  // steps then also differ from the stored hash, so `verify` keeps warning until someone
  // restores the generated steps. (The originally generated steps can't be recovered to hash
  // them plus the new ones, so leaving the stale hash is the only way to keep the edit visible.)
  const tampered = manifest !== undefined && hashVerify(manifest.verify) !== manifest.verify_hash;
  if (tampered) {
    warnings.push(
      `the verify steps in ${MANIFEST_PATH} were edited since openscaffold generated them. Weakening or removing a step to make verify pass counts as a failure; fix the code instead`,
    );
  }

  // Files parked under incoming/ by an earlier run that nobody reconciled. Keep them; this run
  // only adds to them (see planRender). The incoming dir is checked first so a symlinked one
  // is never listed.
  assertMetadataInside(dir);
  const incoming = join(dir, INCOMING_DIR);
  const parkedBefore = listFiles(incoming);
  const planned = new Set(plan.files.map((op) => op.dest));
  const leftover = parkedBefore.filter((f) => !planned.has(parkedDest(f, [...planned])));
  if (leftover.length) {
    warnings.push(
      `${INCOMING_DIR}/ still has files from an earlier run that haven't been reconciled (${leftover.join(", ")}); they're kept and listed in the brief`,
    );
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
  const render = planRender(plan.files, dir, vars, { incomingDir: incoming });
  const { written, skipped } = render;
  // Each path to merge, with every copy parked for it: earlier runs' and this run's.
  const copies = new Map<string, string[]>();
  for (const f of parkedBefore) {
    const dest = parkedDest(f, parkedBefore);
    if (planned.has(dest) && !skipped.includes(dest)) continue;
    copies.set(dest, [...(copies.get(dest) ?? []), f]);
  }
  for (const { dest, incoming: copy } of render.parked) {
    const list = copies.get(dest) ?? [];
    copies.set(dest, list.includes(copy) ? list : [...list, copy]);
  }
  const mergeNeeded = [
    ...new Set([...skipped, ...leftover.map((f) => parkedDest(f, parkedBefore))]),
  ];
  const incomingCopies = Object.fromEntries(mergeNeeded.map((f) => [f, copies.get(f) ?? [f]]));

  const now = (opts.now ?? new Date()).toISOString();
  const verify = [...existingSteps, ...newSteps];
  const next = ManifestSchema.parse({
    openscaffold: VERSION,
    schema_version: SCHEMA_VERSION,
    stack: stackId ?? manifest?.stack ?? null,
    preset,
    agents: [...new Set([...(manifest?.agents ?? []), ...plan.agents])],
    fragments: [...(manifest?.fragments ?? []), ...plan.fragments.map((f) => f.id)],
    vars: { ...(manifest?.vars ?? {}), ...vars },
    env,
    verify,
    verify_hash: tampered ? (manifest?.verify_hash ?? "") : hashVerify(verify),
    created: manifest?.created ?? now,
    updated: now,
  } satisfies Manifest);

  const cli = opts.cli ?? cliInvocation();
  const verifyCommand = `${cli} verify`;
  // Everything that can fail (rendering, path checks, the brief's conditionals, the manifest
  // schema) runs before the first write, so a bad fragment leaves the project as it was.
  const briefText = buildBrief({
    mode: "add",
    vars,
    plan,
    existingFragments: manifest?.fragments ?? [],
    written,
    mergeNeeded,
    incoming: incomingCopies,
    yes: Boolean(opts.yes) || next.preset === "sandbox",
    verify,
    env,
    cli,
    untrusted: untrustedEntries(plan, dir),
    untrustedFrom: dir,
  });
  render.apply();
  writeManifest(dir, next);
  const brief = writeBrief(dir, briefText);

  if (!opts.json) {
    print(
      `Added ${plan.fragments.map((f) => f.id).join(", ")} to ${dir} (${written.length} files written${
        skipped.length ? `, ${skipped.length} already existed and need merging` : ""
      }).`,
    );
    print(`Brief: ${brief}`);
    print("");
  }
  const handoff = await runHandoff(opts, {
    dir,
    plan,
    verifyCommand,
    configAgents: config.agents,
    registryDir: dir,
  });

  const result: AddResult = {
    dir,
    stack: next.stack,
    added: plan.fragments.map((f) => f.id),
    fragments: next.fragments,
    agents: next.agents,
    written,
    mergeNeeded,
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
