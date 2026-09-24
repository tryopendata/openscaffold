import { basename, isAbsolute, resolve } from "node:path";
import { toolOnPath } from "./compose.js";
import { applyConditionals, type ConditionContext } from "./conditionals.js";
import { SANDBOX_SKIPPED_TAGS, type VerifyStep } from "./schema/index.js";
import type { ComposedPlan, Entry } from "./types.js";
import { VERSION } from "./version.js";

/** Where `add` puts openscaffold's version of files that already existed. */
export const INCOMING_DIR = ".openscaffold/incoming";

export interface InvocationContext {
  /** Script path the runtime was started with (process.argv[1]). */
  script?: string;
  /** Set when running under bun (process.versions.bun). */
  bun?: boolean;
  /** This CLI's version, pinned in the npx form. */
  version?: string;
  /** PATH lookup (default: toolOnPath). */
  onPath?: (bin: string) => boolean;
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command an agent should use to call this same CLI:
 * - `npx -y openscaffold@<version>` when running from a package in node_modules (npx or a local
 *   install), so `verify` runs with the CLI version that wrote the manifest;
 * - bare `openscaffold` for a global install (the script is named openscaffold and is on PATH);
 * - otherwise the runtime plus the absolute path of the local checkout.
 */
export function cliInvocation(
  ctx: InvocationContext = { script: process.argv[1], bun: Boolean(process.versions.bun) },
): string {
  const npx = `npx -y openscaffold@${ctx.version ?? VERSION}`;
  const script = ctx.script;
  if (!script) return npx;
  const abs = isAbsolute(script) ? script : resolve(script);
  if (/[\\/]node_modules[\\/]/.test(abs)) return npx;
  if (basename(abs) === "openscaffold" && (ctx.onPath ?? toolOnPath)("openscaffold")) {
    return "openscaffold";
  }
  if (/\.[cm]?ts$/.test(abs)) return `bun ${shellQuote(abs)}`;
  return `${ctx.bun ? "bun" : "node"} ${shellQuote(abs)}`;
}

export interface BriefInput {
  mode: "new" | "add";
  vars: Record<string, string>;
  plan: ComposedPlan;
  /** Fragments applied by earlier runs (add only). */
  existingFragments?: string[];
  /** Files openscaffold wrote this run, relative to the project root. */
  written: string[];
  /** Files that already existed; openscaffold's version is under INCOMING_DIR (add only). */
  mergeNeeded: string[];
  /** Use stated defaults instead of asking the user (--yes or --sandbox). */
  yes: boolean;
  /** Every verify step in the manifest after this run (add: existing plus new). */
  verify: VerifyStep[];
  env: Record<string, string>;
  /** How to call this CLI, e.g. `npx openscaffold`. */
  cli: string;
}

/** Shift markdown headings (outside code fences) so the shallowest becomes `level`. */
export function nestHeadings(markdown: string, level: number): string {
  const lines = markdown.split("\n");
  let fence: string | undefined;
  const headings: number[] = [];
  const isHeading = lines.map((line) => {
    const f = /^\s*(```|~~~)/.exec(line)?.[1];
    if (f) {
      if (fence === undefined) fence = f;
      else if (f === fence) fence = undefined;
      return 0;
    }
    if (fence !== undefined) return 0;
    const m = /^(#{1,6})\s/.exec(line);
    if (m?.[1]) headings.push(m[1].length);
    return m?.[1]?.length ?? 0;
  });
  if (headings.length === 0) return markdown;
  const shift = level - Math.min(...headings);
  return lines
    .map((line, i) => {
      const depth = isHeading[i] ?? 0;
      if (!depth) return line;
      return `${"#".repeat(Math.min(6, Math.max(1, depth + shift)))}${line.slice(depth)}`;
    })
    .join("\n");
}

function code(s: string): string {
  return s.includes("`") ? `\`\` ${s} \`\`` : `\`${s}\``;
}

function bullets(items: string[]): string {
  return items.map((i) => `- ${i}`).join("\n");
}

function entrySection(title: string, entry: Entry, when: ConditionContext): string {
  const m = entry.meta;
  const facts: string[] = [];
  const deps = Object.entries(m.deps).filter(([, names]) => names.length);
  if (deps.length) {
    facts.push(
      `Dependencies (names only; install current versions):\n${deps
        .map(([role, names]) => `  - ${role}: ${names.join(", ")}`)
        .join("\n")}`,
    );
  }
  const tools = [...new Set([...m.tools, ...(m.kind === "fragment" ? m.requires_tools : [])])];
  if (tools.length) facts.push(`Tools: ${tools.join(", ")}`);
  const parts = [`## ${title}`, m.description];
  if (facts.length) parts.push(bullets(facts));
  // Drop a leading "# <name>" heading: the section title already says it.
  const prose = applyConditionals(entry.body, when, `${entry.kind} ${entry.id}`);
  const body = prose.replace(/^#\s+(.+)\n+/, (whole, h: string) =>
    h.trim().toLowerCase() === m.name.toLowerCase() ? "" : whole,
  );
  if (body) parts.push(nestHeadings(body, 3));
  return parts.join("\n\n");
}

function verifyTable(steps: VerifyStep[], sandbox: boolean): string {
  const skipped = new Set(SANDBOX_SKIPPED_TAGS);
  const order = ["setup", "check", "serve", "teardown"];
  const sorted = [...steps].sort((a, b) => order.indexOf(a.phase) - order.indexOf(b.phase));
  const rows = sorted.map((s) => {
    const probe = s.expect ? `${s.expect.http} within ${s.expect.within}` : "";
    const cwd = s.cwd ? ` (in ${code(s.cwd)})` : "";
    const skip = sandbox && s.tags.some((t) => skipped.has(t)) ? " (skipped: sandbox)" : "";
    return `| ${s.name}${skip} | ${s.phase} | ${code(s.run).replace(/\|/g, "\\|")}${cwd} | ${probe} |`;
  });
  return ["| Step | Phase | Command | Probe |", "|---|---|---|---|", ...rows].join("\n");
}

/** `.openscaffold/BRIEF.md`: the complete task for the coding agent. */
export function buildBrief(input: BriefInput): string {
  const { plan, vars, cli } = input;
  const verifyCmd = `${cli} verify`;
  const sandbox = plan.preset === "sandbox";
  const name = vars.project_name ?? "this project";
  const fragmentIds = plan.fragments.map((f) => f.id);
  const out: string[] = [];

  // 1. Title and facts.
  if (input.mode === "new") {
    out.push(`# Build ${name}: ${plan.stack ? plan.stack.meta.name : "project"}`);
  } else {
    out.push(`# Add ${fragmentIds.join(", ")} to ${name}`);
  }
  const facts = [
    plan.stack
      ? `Stack: ${plan.stack.meta.name} (${code(plan.stack.id)})`
      : "Stack: none recorded (existing repo)",
    `${input.mode === "add" ? "Adding fragments" : "Fragments"}: ${fragmentIds.length ? fragmentIds.join(", ") : "none"}`,
    ...(input.existingFragments?.length
      ? [`Already applied: ${input.existingFragments.join(", ")}`]
      : []),
    `Preset: ${sandbox ? "sandbox (local only, never deployed)" : "default"}`,
    `Target agents: ${plan.agents.join(", ") || "none"}`,
    "Project root: the directory that contains this `.openscaffold/` folder. Run every command from there.",
  ];
  out.push(bullets(facts));
  out.push(
    `This file is your task. openscaffold, a scaffolding CLI, copied a few starter files and wrote this brief. It did not install anything or run any generator; that's your job.${
      cli === "openscaffold"
        ? ""
        : ` Wherever the guidance below says \`openscaffold <cmd>\`, run \`${cli} <cmd>\`.`
    }`,
  );

  // 2. Job.
  out.push(
    [
      "## Your job",
      input.mode === "new"
        ? `Turn this directory into a working development environment for the stack described below. You're done when ${code(verifyCmd)} exits 0. Work through it autonomously; stop only for the decisions and missing tools called out below.`
        : `Apply the fragments described below to this existing project without breaking what's already here. You're done when ${code(verifyCmd)} exits 0. Work through it autonomously; stop only for the decisions and missing tools called out below.`,
    ].join("\n\n"),
  );

  // 3. Versions.
  out.push(
    [
      "## Versions",
      bullets([
        "Nothing here pins a version, on purpose. Use the latest stable versions that work together.",
        "Prefer each framework's official generator or init command over writing its files by hand.",
        "Check current docs (the official site, `--help`, the package registry) before writing config or calling an API. Don't trust remembered flags, config keys, or APIs; they change between releases.",
        "Don't pin to versions you remember. Let the package manager resolve them. Committing lockfiles is expected.",
      ]),
    ].join("\n\n"),
  );

  // 4. Ground rules.
  const rules = [
    "Run generators non-interactively (pass whatever flags skip their prompts). Point them at their target subdirectory, or run them in a temp dir and merge the result in. Never run a generator into the already-populated project root; it will refuse or overwrite files.",
  ];
  if (input.mode === "new") {
    rules.push(
      "The project root is already a git repository with no commits. Skip generators' own git setup, and commit once verify passes.",
    );
  }
  if (input.written.length) {
    rules.push(
      `openscaffold wrote these files. They're starting points: adapt them to what you build, don't delete them.\n${summarizePaths(
        input.written,
      )
        .map((f) => `  - ${f}`)
        .join("\n")}`,
    );
  }
  rules.push(
    "Keep `AGENTS.md` accurate. Every command it lists must be a real command this project exposes, and it should describe the project as it actually ends up.",
  );
  rules.push(
    "Leave `.openscaffold/manifest.yaml` alone. Its `verify` block is the definition of done.",
  );
  if (plan.missingTools.length) {
    const byTool = new Map<string, string[]>();
    for (const { tool, owner } of plan.missingTools) {
      byTool.set(tool, [...(byTool.get(tool) ?? []), owner]);
    }
    const list = [...byTool].map(
      ([tool, owners]) => `${code(tool)} (needed by ${owners.join(", ")})`,
    );
    rules.push(
      `These tools weren't on PATH when openscaffold ran: ${list.join(", ")}. Install them if you can do it without admin rights or an interactive prompt (e.g. the user's package manager or the tool's official installer). Otherwise tell the user exactly what to install and wait; verify can't pass without them.`,
    );
  }
  out.push(["## Ground rules", bullets(rules)].join("\n\n"));

  // 5. Decisions.
  if (plan.decisions.length) {
    out.push(
      [
        "## Decisions",
        input.yes
          ? "Use each item's default without asking the user, and list the choices you made in your final summary."
          : 'Confirm these with the user before you start building. Ask once, in a single short message, and include each default so they can reply "defaults".',
        bullets(plan.decisions),
      ].join("\n\n"),
    );
  }

  // 6. Stack and fragment guidance, with conditional blocks resolved for this project.
  const when: ConditionContext = {
    stack: plan.stack?.id,
    tags: plan.stack?.meta.tags ?? [],
    mode: input.mode,
    preset: plan.preset,
    with: [...new Set([...(input.existingFragments ?? []), ...fragmentIds])],
  };
  if (input.mode === "new" && plan.stack) {
    out.push(
      entrySection(`Stack: ${plan.stack.meta.name} (${code(plan.stack.id)})`, plan.stack, when),
    );
  }
  for (const f of plan.fragments) {
    out.push(entrySection(`Fragment: ${f.meta.name} (${code(f.id)})`, f, when));
  }

  // 7. Merge needed (add).
  if (input.mergeNeeded.length) {
    out.push(
      [
        "## Merge needed",
        `These files already existed, so openscaffold left them untouched and wrote its version to the same path under ${code(`${INCOMING_DIR}/`)}. Reconcile each one: bring in what the incoming version adds (settings keys, hooks, sections, ignore patterns), keep the project's existing choices where the two conflict, and don't drop anything the project relies on. Delete ${code(`${INCOMING_DIR}/`)} when you're done.`,
        input.mergeNeeded
          .map((f) => `- ${code(f)} (incoming: ${code(`${INCOMING_DIR}/${f}`)})`)
          .join("\n"),
      ].join("\n\n"),
    );
  }

  // 8. Definition of done.
  const done = ["## Definition of done"];
  if (input.verify.length) {
    const serve = input.verify.some((s) => s.phase === "serve")
      ? " Serve steps start a dev server and poll the probe URL; the server is stopped afterwards."
      : "";
    done.push(
      `${code(verifyCmd)} runs these steps from \`.openscaffold/manifest.yaml\`, in phase order (setup, check, serve, teardown).${serve}`,
      verifyTable(input.verify, sandbox),
    );
  } else {
    done.push(
      `The manifest has no verify steps yet, so ${code(verifyCmd)} passes trivially. That doesn't prove anything: also run the project's own lint and test commands and make sure what you added works.`,
    );
  }
  const env = Object.entries(input.env);
  if (env.length) {
    done.push(
      `Environment defaults (verify passes these; override one by exporting it, e.g. when a port is taken): ${env
        .map(([k, v]) => code(`${k}=${v}`))
        .join(
          ", ",
        )}. Read ports from these variables rather than hard-coding them, and list them in \`.env.example\`.`,
    );
  }
  done.push(
    "Any command these steps call that doesn't exist yet (a Makefile target, a package script) is yours to create, and it must do real work.",
  );
  done.push(
    `Loop: run ${code(verifyCmd)}, fix what fails, and run it again until every step passes. Weakening or stubbing a step counts as failure, not success: that includes making a command a no-op, skipping or deleting tests, lowering thresholds, or editing the manifest.`,
  );
  done.push(
    [
      "Once verify is green:",
      "1. Check that `AGENTS.md` matches the project as built (real commands, layout, testing approach) with no placeholders left.",
      `2. Commit everything with a conventional commit message (e.g. ${code(
        input.mode === "new"
          ? `feat: scaffold ${vars.project_slug ?? "project"}`
          : `feat: add ${fragmentIds.join(", ")}`,
      )}).`,
      "3. Give the user a short summary: what you built, the decisions you made, the exact command to run it (the dev server, for a web project), and anything they still need to do (accounts, secrets, installs).",
    ].join("\n"),
  );
  out.push(done.join("\n\n"));

  // 9. Sandbox.
  if (sandbox) {
    out.push(
      [
        "## Sandbox",
        "This is a local sandbox that will never be deployed. Skip deploy, release, and production-hardening work; verify skips steps tagged `prod`. Optimize for the fastest path to a green verify.",
      ].join("\n\n"),
    );
  }

  return `${out.join("\n\n")}\n`;
}

/** Collapses directories holding more than three written files into one line, keeping the brief short. */
export function summarizePaths(paths: string[]): string[] {
  const byDir = new Map<string, string[]>();
  for (const p of paths) {
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "";
    byDir.set(dir, [...(byDir.get(dir) ?? []), p]);
  }
  const lines: string[] = [];
  const emitted = new Set<string>();
  for (const p of paths) {
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "";
    const siblings = byDir.get(dir) ?? [];
    if (dir && siblings.length > 3) {
      if (!emitted.has(dir)) lines.push(`${code(dir)} (${siblings.length} files)`);
      emitted.add(dir);
    } else {
      lines.push(code(p));
    }
  }
  return lines;
}
