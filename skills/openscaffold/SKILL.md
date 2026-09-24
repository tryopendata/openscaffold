---
name: openscaffold
description: Scaffolds a new project or dev environment from a known-good stack (Python API + React, Go CLI, Astro blog, and more) and drives it to a verified, working state. Use when the user wants to start a new project, spin up a dev environment quickly, bootstrap a repo for an interview or prototype, or add standard pieces (agent config, CI, git hooks, Postgres, deploy) to an existing repo.
---

# openscaffold

openscaffold holds version-less recipes for dev stacks. You pick a stack, the CLI writes a few starter files and a brief, and then you build the project from the brief using current versions until `openscaffold verify` passes.

## Workflow

1. See what's available. Run `npx openscaffold list --json`. Each entry has an `id`, a `description`, and `tags`.
2. Pick a stack. If the user named one, use it. If they described what they want, choose the closest stack and tell them in one or two sentences why you chose it. If nothing fits, say so. Don't force a poor match.
3. Choose options:
   - `--sandbox` when the user wants something running fast and never deployed (a quick prototype, a coding interview, trying an idea). It skips deploy/release pieces and confirmation questions.
   - `--with a,b` and `--without c` to add or remove fragments. Run `npx openscaffold show <stack>` to see the defaults and known optional fragments.
   - `--yes` to accept stated defaults without asking the user.
4. Scaffold. Run `npx openscaffold new <stack> <dir> [options]`. The CLI detects that you're an agent and tells you to read the brief instead of launching anything.
5. Build. Read `<dir>/.openscaffold/BRIEF.md` and do what it says. It is the full task: stack guidance, fragment guidance, decisions to confirm, and the definition of done.
6. Verify. Run the exact verify command printed in the brief, from the project root, and fix failures until it passes. Don't edit or weaken verify steps to make them pass.
7. Report to the user: what was built, the commands to start the dev server and run tests, and anything left for them to do (API keys, remote hosts).

## Existing repos

To add standard pieces to a repo that already exists, run `npx openscaffold add <fragment...>` from its root, then follow the new brief. Existing files are never overwritten. The brief lists anything you need to merge by hand.

## Notes

- Every read command takes `--json`.
- `npx openscaffold` with no arguments prints a short guide.
- The user's personal stacks and defaults live in `~/.openscaffold/`. `list` shows where each entry came from.
- Stack files never pin versions. Install the latest compatible versions and check current docs rather than relying on what you remember about a tool's config format.
