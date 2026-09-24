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
  - "Module path: default github.com/<owner>/<project-slug>, where owner is the package scope or author. Ask if unsure; it's painful to change later."
  - "Binary name: the project slug (default). The Makefile's BIN variable holds it."
  - "Config file: YAML at ~/.config/<binary>/config.yaml plus an optional project-local file (default), or env and flags only."
  - "Default output mode: human-readable with --json for machines (default), or JSON by default with --pretty."
  - "Coverage floor for make coverage and CI: 50% (default)."
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
---

# Go CLI

A single-binary command-line tool. `cmd/<bin>/main.go` stays tiny, everything else lives under `internal/`. Commands are cobra, configuration is viper layered as defaults, then config file, then environment, then flags. Errors carry a code, a message, and a suggestion for how to fix the problem, and they render the same way from every command. The `Makefile` is the entry point for build, lint, test, and release tasks.

## Layout

```
.
├── Makefile
├── go.mod / go.sum
├── cmd/
│   └── <bin>/main.go          version/commit/date vars (set by -ldflags), calls cli.Execute()
├── internal/
│   ├── cli/                   cobra commands
│   │   ├── root.go            root command, persistent flags (--config, --json, --verbose, --no-color), Execute()
│   │   ├── version.go         version command (and root.Version for --version)
│   │   └── <command>.go       one file per command, each with a matching _test.go
│   ├── config/                typed Config struct, Load() via a viper instance, Validate()
│   ├── errors/                structured Error type, codes, exit-code mapping
│   └── output/                human vs JSON rendering, TTY and NO_COLOR detection
├── tests/
│   └── integration/           black-box tests that build and run the binary (build tag: integration)
├── docs/
│   ├── ARCHITECTURE.md        package map, data flow, error design
│   ├── configuration.md       every config key, env var, and flag
│   └── DEVELOPMENT.md         setup, make targets, testing, releasing
└── tapes/                     optional VHS demo scripts (*.tape)
```

## Setup

The root already has files openscaffold wrote (Makefile, README, .gitignore, .editorconfig, agent config). No generator is needed for a Go CLI; write the code by hand.

1. Run `go mod init <module path>` at the root with the module path the user confirmed.
2. `go get` cobra, viper, and testify. Let `go mod tidy` settle the versions.
3. Write `internal/errors`, `internal/output`, `internal/config`, then `internal/cli/root.go` and `version.go`, then `cmd/<bin>/main.go`. Make sure `BIN` in the Makefile matches the directory name under `cmd/`.
4. Add one real example command (for example `config show`, which prints the resolved config in human or JSON form). It exercises config loading, output modes, and errors end to end.
5. Write `.golangci.yml` per Tool configuration for the golangci-lint you have installed.
6. Write unit tests for errors, config precedence, and each command, plus one integration test in `tests/integration/` that builds the binary and runs `--help`, `--version`, and the example command.
7. Write the three docs files as short, accurate skeletons.
8. Run `openscaffold verify` and loop until it passes.

## Conventions

- **Thin main.** `main.go` declares `var version, commit, date = "dev", "none", "unknown"`, hands them to the cli package, and calls `cli.Execute()`. It holds no logic, and only `Execute()` calls `os.Exit`.
- **Commands.** Each command is built by a constructor (`newFooCmd() *cobra.Command`) rather than as a package-level var with `init()` side effects, so tests can build a fresh tree. Use `RunE`, never `Run`, and return errors. Set `SilenceUsage` and `SilenceErrors` on the root so cobra doesn't print errors itself; `Execute()` prints each error exactly once. Use cobra's `Args` validators (`cobra.ExactArgs`, etc.) for arity. Take the context from `cmd.Context()` and set it up in `Execute()` with `signal.NotifyContext` for SIGINT/SIGTERM so Ctrl-C cancels cleanly.
- **I/O through the command.** Commands write with `cmd.OutOrStdout()` and `cmd.ErrOrStderr()`, never `fmt.Println`, so tests can capture output with `SetOut`/`SetErr`. Results go to stdout, and progress, logs, and errors go to stderr.
- **Config.** `config.Load(flags)` builds a fresh `viper.New()` (never the global viper, which leaks state between tests). Set defaults, read the config file if present (a missing file is fine, a malformed one is an error), `SetEnvPrefix(<BIN upper>)`, `AutomaticEnv()`, a key replacer mapping `.` and `-` to `_`, and bind persistent flags. Unmarshal into a typed `Config` struct and call `Validate()`, which returns structured config errors. Commands receive the `Config` and don't read viper directly.
- **Structured errors.** `internal/errors` defines `type Error struct { Code, Message, Suggestion string; Cause error }` with `New(code, message, suggestion)`, `Wrap(err, code, message, suggestion)`, `Unwrap()` so `errors.Is`/`errors.As` work, and a small set of UPPER_SNAKE code constants (`CONFIG`, `CONFIG_NOT_FOUND`, `INVALID_INPUT`, `NOT_FOUND`, `IO`, `INTERNAL`) that grow with the domain. The human rendering is three parts: what failed, why (the cause), and how to fix it (the suggestion). Every error a user can hit should have a suggestion. Errors that aren't `*Error` get wrapped as `INTERNAL` at the top level.
- **Exit codes.** 0 success, 1 runtime error, 2 usage error (bad flags or args). Map them in one function in `internal/errors` or `internal/cli`. If a command runs a child process, propagate its exit code through a dedicated error type.
- **Output modes.** `--json` switches every command to machine output: results as a single JSON document on stdout, errors as `{"error":{"code","message","suggestion"}}` on stderr. Human mode uses color only when stdout is a TTY and `NO_COLOR` is unset. Put this in `internal/output` so commands don't branch on it.
- **Packages.** Everything is under `internal/` unless the user wants a public Go API (then add `pkg/` deliberately). Keep dependencies pointing one way: `cli` imports `config`, `errors`, `output`, and domain packages; domain packages never import `cli`.
- **Docs stay current.** When a flag, config key, or env var changes, update `docs/configuration.md` in the same change.
- **Demos (optional).** If the user wants terminal GIFs, add VHS `.tape` files under `tapes/` and a `make demos` target that skips with a message when `vhs` isn't installed.

## Tool configuration

Write `.golangci.yml` for the golangci-lint version you installed; its config schema has changed between majors, so check the current docs for key names.

- **Linters**: govet, errcheck, staticcheck, unused, ineffassign, gocritic (diagnostic and performance tags; disable hugeParam, appendCombine, ifElseChain, wrapperFunc), gocyclo (min complexity 30, since CLI dispatch is branchy), misspell, unconvert, unparam, gosec, revive, and nolintlint (require an explanation and a specific linter on every `//nolint`).
- **revive rules**: blank-imports, context-as-argument, context-keys-type, dot-imports, error-return, error-strings, error-naming, increment-decrement, var-declaration, range, receiver-naming, time-naming, unexported-return, indent-error-flow, errorf, empty-block, superfluous-else, unreachable-code, redefines-builtin-id. Disable `exported` (too noisy for internal packages) and `package-comments`. Disable `var-naming` if the errors package shadows the standard library's name.
- **errcheck**: exclude functions where ignoring the error is normal (`fmt.Fprint*`, `(io.Closer).Close` in defers, `os.Setenv`/`os.Unsetenv` in tests).
- **gosec**: keep it on. Exclude only rules that fire on the tool's intended behavior, each with a comment (a CLI that runs user commands will trip the subprocess rules; one that reads user-named files will trip file-path rules).
- **Formatters**: gofmt and goimports.
- **Exclusions**: generated files; relax gocyclo, gosec, errcheck, and unparam in `_test.go`. Include the `integration` build tag so those files get linted too.
- **Version**: record the golangci-lint version you installed in one place that both the Makefile and CI read (a `.golangci-version` file works), so local and CI runs agree. That's the project's own lock, the same as `go.sum`.

## Testing

- **Unit tests** live next to the code (`foo_test.go`), table-driven with `t.Run` subtests, using testify's `require` for preconditions and `assert` for checks.
- **Command tests** build the command tree with the constructor, set args, capture stdout/stderr with buffers, and assert on output and returned errors, including the error code and that a suggestion is present. Use `t.TempDir()` for config files and `t.Setenv` for env vars (never `os.Setenv` in tests).
- **Config precedence** gets its own table test: default < file < env < flag.
- **Integration tests** in `tests/integration/` carry `//go:build integration`. `TestMain` builds the binary once into a temp dir, and tests run it with `os/exec` and assert on exit codes, stdout, and stderr. Run them with `make test-integration`.
- **Race and coverage**: `make coverage` runs `go test -race -coverprofile` and fails under the agreed floor (default 50%). CI runs it. `make test` skips `-race` so it works on machines without a C toolchain.

## Commands

Makefile targets (shipped as a starting point; adapt, but keep the names). `openscaffold verify` calls install, build, lint, test, and smoke. Mirror this list in AGENTS.md's Commands section.

| Target | What it does |
|---|---|
| `make install` | `go mod download`, install goimports if missing |
| `make build` | `go build` with version ldflags into `bin/<bin>` |
| `make lint` | golangci-lint run (fails with install instructions if it's missing) |
| `make lint-fix` | golangci-lint run --fix |
| `make fmt` / `make fmt-check` | gofmt + goimports / fail if anything is unformatted |
| `make test` | `go test ./...` |
| `make test-integration` | `go test -tags integration ./tests/integration/...` |
| `make coverage` | race-enabled tests with a coverage floor |
| `make smoke` | build, then run `bin/<bin> --help` and `--version` |
| `make ci` | fmt-check, lint, coverage, build: what CI runs |
| `make clean` | remove `bin/`, `dist/`, coverage files |

## Gotchas

- viper lowercases every key and treats dots as nesting. Don't use it for maps whose keys are user data (env var names, hostnames, task names); decode those sections with a YAML library into your own types.
- A package-level `rootCmd` with `init()` registration makes tests order-dependent. Build the tree in a function.
- `-race` needs cgo and a C compiler. It works on CI runners and most dev machines, but not in minimal containers; that's why it lives in `make coverage` rather than `make test`.
- golangci-lint releases add linters and rename config keys. A newer local binary can pass while CI fails, or the other way round. Keep the recorded version in sync, and change it on purpose.
- Integration test files behind a build tag are invisible to `go vet`, gopls, and golangci-lint unless the tag is passed. Configure the tag in the lint config and editor settings.
- `go install ...@latest` for dev tools lands in `$(go env GOPATH)/bin`, which may not be on PATH. The Makefile looks there as a fallback.
- `--version` output comes from `root.Version`. Without ldflags it prints `dev`, which is expected for local builds.
