---
description: Scaffold a stack (or add fragments) with the built CLI into a scratch dir and check what an agent would receive
argument-hint: <stack> [--build] | add <fragment...>
---

End-to-end check of the scaffolding path, using the built CLI under Node as users run it. Arguments: `$ARGUMENTS`

## 1. Build

```bash
bun run build
```

## 2. Scaffold into a scratch directory

Make a fresh directory in your scratchpad (or `mktemp -d`); call it `$DIR`. Use absolute paths throughout: the shell's cwd resets between commands.

- Stack (`<stack>`): `node dist/cli.js new <stack> "$DIR/<stack>" --sandbox --no-launch`
- Fragments (`add <fragment...>`): `git init -q "$DIR/repo"`, then from inside it run `node <repo>/dist/cli.js add <fragment...> --no-launch`

`OPENSCAFFOLD_OFFLINE=1` comes from `.claude/settings.json`, so this uses the bundled registry in `registry/`.

## 3. Check the output

- The command exited 0 and printed a next step that names `.openscaffold/BRIEF.md`.
- List the tree (skip `.git`). Every file comes from an entry's `files/` or `adapters/claude/`; `.tmpl` suffixes are gone.
- No template tokens survived rendering: `grep -rn '{{' "$PROJECT" --exclude-dir=.git` should only hit files that legitimately contain `{{` (workflows with `${{ }}`, Go templates), never a `.tmpl`-rendered file.
- `BRIEF.md` has no leftover conditional markers (`openscaffold:when`, `openscaffold:end`), includes the guidance of every composed fragment, and its conditional blocks match this stack and preset. Read it once as the agent would: note anything ambiguous, contradictory, or version-specific.
- `.openscaffold/manifest.yaml` lists the verify steps, and `node <repo>/dist/cli.js verify --dir "$PROJECT" --json` prints a well-formed report. It is expected to fail at the first setup step, since nothing has been built yet.
- With `agent-ops` composed: `.claude/settings.json` parses (`jq . `), and piping a destructive payload into `.claude/hooks/block-destructive.sh` returns a deny.

## 4. Optional: build it for real (`--build`)

Only when `--build` is in the arguments, act as the target agent: read `$PROJECT/.openscaffold/BRIEF.md` and carry it out in `$PROJECT` until `node <repo>/dist/cli.js verify --dir "$PROJECT"` passes, without weakening any step. Keep a list of every point where you hesitated, guessed, or had to work around the brief. Those are the findings: prose in `registry/` to clarify.

## 5. Report

The scratch path, file count, pass/fail for each check above, and the findings, each with the registry file it points at. Leave the scratch directory in place.
