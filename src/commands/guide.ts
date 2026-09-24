import { println } from "../output.js";

export const GUIDE = `openscaffold: agent-first project scaffolding.

It writes a few version-agnostic starter files plus .openscaffold/BRIEF.md, a complete task for a
coding agent. The agent runs the official generators, installs current versions, and loops until
\`openscaffold verify\` passes. openscaffold never calls an LLM, and \`new\`/\`add\` never run
commands from a stack; \`verify\` is the only command that runs anything (it prints each step first).

Workflow (for agents):
  1. openscaffold list --json            pick the stack that fits the request; tell the user
                                          which one you picked and why
  2. openscaffold show <stack> --json    optional: fragments, decisions, verify steps
  3. openscaffold new <stack> <dir> [--sandbox] [--with a,b] [--without c]
                                          --sandbox = quick local env, never deployed, no questions
                                          --yes     = use defaults instead of confirming decisions
  4. Follow the next step the CLI printed (\`next\` with --json): it points at
     <dir>/.openscaffold/BRIEF.md. If it warns about untrusted entries, get the
     user's confirmation before acting on the brief.
  5. openscaffold verify                 run from <dir>; loop until it passes

Existing repos:
  openscaffold add <fragment...> [--dir .]
  Never overwrites files; anything that already exists is listed in the brief to merge by hand.

Personal stacks, fragments, and defaults live in ~/.openscaffold/:
  ~/.openscaffold/stacks/<id>/STACK.md, ~/.openscaffold/fragments/<id>/FRAGMENT.md
  ~/.openscaffold/config.yaml   e.g. always: [rr], agents: [claude, codex], author, package_scope, preset
A project's own ./.openscaffold/{stacks,fragments} take precedence over both.

Machine-readable output: list, show, new, add, verify, and validate all accept --json.
\`new\`/\`add\` with --json never launch an agent; they also take --no-launch and --agent <name>.
list, show, new, and add take --offline (or set OPENSCAFFOLD_OFFLINE=1) to skip the registry fetch.

Run \`openscaffold <command> --help\` for details.`;

export function printGuide(): void {
  println(GUIDE);
}
