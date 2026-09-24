---
schema_version: 1
id: go-cli
kind: stack
name: Go CLI
description: A Go command-line tool with cobra commands, viper config (file, env, flags), structured errors with actionable suggestions, human and JSON output, testify tests with race detection and a coverage floor, and golangci-lint.
tags: [go, cli]
deps:
  cli: [github.com/spf13/cobra, github.com/spf13/viper]
  test: [github.com/stretchr/testify]
tools: [go, make, git, golangci-lint]
decisions:
  - "Module path: github.com/<owner>/<project-slug> (default), owner from `gh api user -q .login` or the git remote, never the author's display name. Ask if neither exists."
  - "Binary name: the project slug (default; the Makefile's BIN)."
  - "Config: YAML at ~/.config/<binary>/config.yaml plus an optional project-local file (default), or env and flags only."
  - "Output: human with --json (default), or JSON with --pretty."
  - "Coverage floor: 50% (default)."
env: {}
fragments:
  default: [agent-ops, git-hooks, ci-github]
  optional: [goreleaser, rr, ce-plugin]
verify:
  - { name: install, phase: setup, run: make install }
  - { name: build, run: make build }
  - { name: lint, run: make lint }
  - { name: test, run: make test }
  - { name: smoke, run: make smoke }
  - name: readme-filled
    run: "test -s README.md && ! grep -n 'openscaffold:fill' README.md"
---

# Go CLI

A single-binary CLI: cobra commands, viper config (defaults < file < env < flags), structured errors with fix suggestions, and the `Makefile` as the entry point for every task.

## Layout

```
cmd/<bin>/main.go      version/commit/date vars (ldflags), calls cli.Execute()
internal/cli/          root.go (persistent flags --config --json --verbose --no-color, Execute()),
                       version.go, one <command>.go + _test.go per command
internal/config/       typed Config, Load() via a fresh viper instance, Validate()
internal/errors/       structured Error, codes, exit-code mapping
internal/output/       human vs JSON rendering, TTY and NO_COLOR detection
tests/integration/     black-box tests of the built binary (build tag: integration)
docs/                  ARCHITECTURE.md, configuration.md (every key/env/flag), DEVELOPMENT.md
```

## Setup

No generator; write the code by hand at the root.

1. `go mod init <module path>`, `go get` cobra, viper, testify, `go mod tidy`.
2. Write errors, output, config, `cli/root.go` + `version.go`, then `main.go`. `BIN` in the Makefile must match the `cmd/` directory.
3. Add one real command (for example `config show`) that exercises config, output modes, and errors end to end.
4. Write `.golangci.yml` for the installed golangci-lint and its version to `.golangci-version`.
5. Tests per Testing; short docs skeletons; fill the README's `openscaffold:fill` markers (`readme-filled` checks).
6. Run `openscaffold verify` until it passes.

## Conventions

- **Thin main**: declares `var version, commit, date = "dev", "none", "unknown"`, passes them to `cli`, calls `cli.Execute()`. Only `Execute()` calls `os.Exit`.
- **Commands**: constructors (`newFooCmd() *cobra.Command`), never package-level vars with `init()`, so tests get a fresh tree. `RunE`, cobra `Args` validators. Root sets `SilenceUsage`/`SilenceErrors`; `Execute()` prints each error once and builds the context with `signal.NotifyContext`.
- **I/O**: `cmd.OutOrStdout()`/`cmd.ErrOrStderr()`, never `fmt.Println`. Results to stdout, everything else to stderr.
- **Config**: `config.Load(flags)` uses `viper.New()` (never the global). Defaults, then the config file if present (missing is fine, malformed is an error), `SetEnvPrefix(<BIN upper>)`, `AutomaticEnv()`, a key replacer mapping `.` and `-` to `_`, bound persistent flags. Unmarshal into `Config`, call `Validate()`. Commands receive `Config`, never read viper.
- **Errors**: `internal/errors` has `type Error struct { Code, Message, Suggestion string; Cause error }`, `New`, `Wrap`, `Unwrap()`, and UPPER_SNAKE codes (`CONFIG`, `CONFIG_NOT_FOUND`, `INVALID_INPUT`, `NOT_FOUND`, `IO`, `INTERNAL`). Human rendering: what failed, why, how to fix. Every user-reachable error has a suggestion; non-`*Error`s are wrapped as `INTERNAL` at the top.
- **Exit codes**: 0 success, 1 runtime, 2 usage, mapped in one function.
- **Output**: `--json` makes every command emit one JSON document on stdout and errors as `{"error":{"code","message","suggestion"}}` on stderr. Color only on a TTY with `NO_COLOR` unset. All of this lives in `internal/output`.
- **Packages**: `internal/` unless the user wants a public API. Domain packages never import `cli`. A changed flag, key, or env var updates `docs/configuration.md`.

## Tool configuration

`.golangci.yml`, written for the installed version (its schema changed between majors):

- **Linters**: govet, errcheck, staticcheck, unused, ineffassign, gocritic (diagnostic + performance; disable hugeParam, appendCombine, ifElseChain, wrapperFunc), gocyclo (min 30), misspell, unconvert, unparam, gosec, revive, nolintlint (require explanation and specific linter).
- **revive**: blank-imports, context-as-argument, context-keys-type, dot-imports, error-return, error-strings, error-naming, increment-decrement, var-declaration, range, receiver-naming, time-naming, unexported-return, indent-error-flow, errorf, empty-block, superfluous-else, unreachable-code, redefines-builtin-id. Disable `exported`, `package-comments`, and `var-naming` if the errors package shadows the stdlib name.
- **errcheck**: exclude `fmt.Fprint*`, `(io.Closer).Close`, and `os.Setenv`/`os.Unsetenv`.
- **gosec**: on; exclude only rules that fire on the tool's intended behavior, each with a comment.
- **Formatters**: gofmt, goimports. **Exclusions**: generated files; relax gocyclo, gosec, errcheck, unparam in tests. Enable the `integration` build tag.
- **Version**: write the installed version (for example `2.x.y`) to `.golangci-version`. `make lint` warns when the local binary differs, and CI reads the same file.

## Testing

- Unit tests next to code, table-driven with `t.Run`, testify `require` for preconditions and `assert` for checks.
- Command tests build the tree via the constructor, capture output with `SetOut`/`SetErr`, and assert on output, error code, and that a suggestion exists. `t.TempDir()` for config files, `t.Setenv` for env (never `os.Setenv`).
- A config precedence table test: default < file < env < flag.
- Integration tests (`//go:build integration`): `TestMain` builds the binary once into a temp dir; tests run it with `os/exec` and assert exit codes and output.
- `make coverage` runs with `-race` and the agreed floor. `make test` skips `-race` (it needs cgo).

## Commands

The shipped Makefile (`make help`) has install, build, lint, lint-fix, fmt, fmt-check (gofmt and goimports), test, test-integration, coverage, vuln (govulncheck), smoke, ci, clean. Adapt recipes, keep the names, mirror them in AGENTS.md.

## Gotchas

- viper lowercases keys and treats dots as nesting. Decode sections whose keys are user data (env var names, hostnames) with a YAML library into your own types.
- cobra already prints `<name> version <v>` for `--version` when `root.Version` is set. Set it to the bare version string; don't prefix the name or "version" again. Without ldflags it prints `dev`.
- Files behind a build tag are invisible to `go vet`, gopls, and golangci-lint unless the tag is configured.
- `go install ...@latest` lands in `$(go env GOPATH)/bin`, which may not be on PATH; the Makefile falls back to it.
