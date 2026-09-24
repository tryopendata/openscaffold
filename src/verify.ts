import { existsSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { resolve } from "node:path";
import { execa } from "execa";
import { OpenScaffoldError } from "./errors.js";
import { hashVerify, MANIFEST_PATH, readManifest } from "./manifest.js";
import { SANDBOX_SKIPPED_TAGS, type VerifyStep } from "./schema/index.js";

export type Phase = VerifyStep["phase"];
export const PHASES: readonly Phase[] = ["setup", "check", "serve", "teardown"];

export interface StepResult {
  name: string;
  phase: Phase;
  run: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  exitCode?: number;
  /** Last ~60 lines of combined stdout/stderr. */
  outputTail?: string;
  /** Why the step was skipped or failed (beyond a non-zero exit). */
  reason?: string;
}

export interface VerifyReport {
  ok: boolean;
  projectDir: string;
  steps: StepResult[];
  warnings: string[];
  totals: { passed: number; failed: number; skipped: number };
}

export type VerifyEvent =
  | { type: "warning"; message: string }
  | { type: "start"; step: VerifyStep; probe?: string }
  | { type: "output"; step: string; chunk: string }
  | { type: "end"; result: StepResult };

export interface VerifyOptions {
  projectDir: string;
  /** Skip steps carrying any of these tags. */
  skipTags?: string[];
  /** Include steps the sandbox preset would skip. */
  all?: boolean;
  /**
   * Run only these check/serve steps. Setup and teardown steps still run (they're what the
   * selected steps depend on); exclude them with skipTags if needed.
   */
  only?: string[];
  /** Overrides manifest env defaults. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  onEvent?: (e: VerifyEvent) => void;
}

const TAIL_LINES = 60;
const POLL_MS = 500;
const KILL_GRACE_MS = 5000;
/** How long to wait for a finished step's output pipes to close before killing leftovers. */
const DRAIN_MS = 2000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function parseDuration(d: string): number {
  const m = /^(\d+)(ms|s|m)$/.exec(d);
  if (!m) throw new OpenScaffoldError("bad_duration", `invalid duration: ${d}`);
  const n = Number(m[1]);
  return m[2] === "ms" ? n : m[2] === "s" ? n * 1000 : n * 60_000;
}

export function expandVars(text: string, env: Record<string, string>): string {
  return text.replace(/\$\{(\w+)\}/g, (whole, key: string) => env[key] ?? whole);
}

class OutputTail {
  private text = "";
  push(s: string): void {
    this.text += s;
    if (this.text.length > 256_000) this.text = this.text.slice(-128_000);
  }
  tail(): string | undefined {
    const lines = this.text.replace(/\s+$/, "").split("\n");
    const out = lines.slice(-TAIL_LINES).join("\n");
    return out === "" ? undefined : out;
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: group already gone
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One GET; resolves to the status code, rejects on connection errors or timeout. */
function probe(url: string, timeoutMs: number): Promise<number> {
  return new Promise((ok, fail) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { agent: false, timeout: timeoutMs }, (res) => {
      res.resume();
      ok(res.statusCode ?? 0);
    });
    req.on("timeout", () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on("error", fail);
  });
}

interface Running {
  pid: number;
  output: OutputTail;
  /** Resolves when the shell process exits. */
  exited: Promise<{ code: number | null; error?: string }>;
  /** Resolves when the process has exited and its output pipes have closed. */
  done: Promise<unknown>;
}

export async function runVerify(opts: VerifyOptions): Promise<VerifyReport> {
  const projectDir = resolve(opts.projectDir);
  const manifest = readManifest(projectDir);
  if (!manifest) {
    throw new OpenScaffoldError(
      "manifest_missing",
      `no ${MANIFEST_PATH} in ${projectDir}`,
      "run `openscaffold new <stack>` to create a project, or `openscaffold add` in an existing repo; verify runs the steps recorded in the manifest",
    );
  }

  const emit = opts.onEvent ?? (() => {});
  const warnings: string[] = [];
  const addWarning = (message: string) => {
    warnings.push(message);
    emit({ type: "warning", message });
  };

  if (hashVerify(manifest.verify) !== manifest.verify_hash) {
    addWarning(
      `the verify steps in ${MANIFEST_PATH} were edited since openscaffold generated them. Weakening or removing a step to make verify pass counts as a failure; fix the code instead`,
    );
  }

  const names = new Set(manifest.verify.map((s) => s.name));
  const unknown = (opts.only ?? []).filter((n) => !names.has(n));
  if (unknown.length > 0) {
    throw new OpenScaffoldError(
      "unknown_step",
      `no verify step named ${unknown.join(", ")}`,
      `steps in the manifest: ${[...names].join(", ")}`,
    );
  }

  const baseEnv = opts.env ?? process.env;
  const env: Record<string, string> = { ...manifest.env };
  for (const [k, v] of Object.entries(baseEnv)) if (v !== undefined) env[k] = v;

  const skipTags = new Set(opts.skipTags ?? []);
  const sandboxTags = new Set(
    manifest.preset === "sandbox" && !opts.all ? SANDBOX_SKIPPED_TAGS : [],
  );
  const only = opts.only && opts.only.length > 0 ? new Set(opts.only) : undefined;

  function selectionSkip(step: VerifyStep): string | undefined {
    for (const tag of step.tags) {
      if (skipTags.has(tag)) return `tagged ${tag} (--skip-tag)`;
      if (sandboxTags.has(tag)) {
        return `tagged ${tag}; the sandbox preset skips it (--all to include)`;
      }
    }
    if (only && (step.phase === "check" || step.phase === "serve") && !only.has(step.name)) {
      return "not selected by --only";
    }
    return undefined;
  }

  // Process groups currently running; killed on interrupt or process exit.
  const active = new Set<number>();
  let interrupted = false;
  let onInterrupt: (() => void) | undefined;

  const onSignal = (signal: NodeJS.Signals) => {
    if (interrupted) {
      for (const pid of active) killGroup(pid, "SIGKILL");
      process.exit(130);
    }
    interrupted = true;
    addWarning(
      `interrupted by ${signal}: stopped the running step, running teardown (again to force)`,
    );
    onInterrupt?.();
  };
  const onExit = () => {
    for (const pid of active) killGroup(pid, "SIGKILL");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", onExit);

  function spawn(step: VerifyStep, cwd: string): Running {
    const output = new OutputTail();
    const child = execa(step.run, {
      shell: true,
      cwd,
      env,
      extendEnv: false,
      detached: true,
      stdin: "ignore",
      buffer: false,
      reject: false,
    });
    const node = child.nodeChildProcess;
    for (const stream of [node.stdout, node.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        output.push(chunk);
        emit({ type: "output", step: step.name, chunk });
      });
    }
    const exited = new Promise<{ code: number | null; error?: string }>((res) => {
      node.once("exit", (code) => res({ code }));
      node.once("error", (err) => res({ code: null, error: err.message }));
    });
    const done = child.then(
      () => undefined,
      () => undefined,
    );
    const pid = node.pid;
    if (pid === undefined) {
      // Spawn failed synchronously; `exited` resolves via the error event.
      return { pid: -1, output, exited, done };
    }
    active.add(pid);
    return { pid, output, exited, done };
  }

  /** SIGTERM the group, SIGKILL whatever is left after the grace period, and wait for exit. */
  async function terminate(r: Running): Promise<void> {
    if (r.pid < 0) return;
    killGroup(r.pid, "SIGTERM");
    const deadline = Date.now() + KILL_GRACE_MS;
    while (groupAlive(r.pid) && Date.now() < deadline) await sleep(100);
    if (groupAlive(r.pid)) killGroup(r.pid, "SIGKILL");
    await r.exited;
    await Promise.race([r.done, sleep(DRAIN_MS)]);
    active.delete(r.pid);
  }

  async function runCommand(step: VerifyStep, cwd: string): Promise<StepResult> {
    const start = Date.now();
    const r = spawn(step, cwd);
    let killedForInterrupt = false;
    onInterrupt = () => {
      killedForInterrupt = true;
      void terminate(r);
    };
    const { code, error } = await r.exited;
    onInterrupt = undefined;
    const drained = await Promise.race([
      r.done.then(() => true),
      sleep(DRAIN_MS).then(() => false),
    ]);
    if (!drained) {
      // Something the step started is still holding its output open. Kill it rather than hang.
      killGroup(r.pid, "SIGKILL");
      await r.done;
      r.output.push(
        "\n[openscaffold] killed processes this step left running (they kept its output open)\n",
      );
    }
    active.delete(r.pid);
    const base = {
      name: step.name,
      phase: step.phase,
      run: step.run,
      durationMs: Date.now() - start,
      outputTail: r.output.tail(),
    };
    if (killedForInterrupt) return { ...base, status: "failed", reason: "interrupted" };
    if (error) return { ...base, status: "failed", reason: `could not start: ${error}` };
    if (code === 0) return { ...base, status: "passed", exitCode: 0 };
    return {
      ...base,
      status: "failed",
      ...(code === null ? { reason: "killed by a signal" } : { exitCode: code }),
    };
  }

  async function runServe(step: VerifyStep, cwd: string, url: string): Promise<StepResult> {
    const start = Date.now();
    const within = parseDuration(step.expect?.within ?? "60s");
    const deadline = start + within;
    const r = spawn(step, cwd);
    let exit: { code: number | null; error?: string } | undefined;
    void r.exited.then((e) => {
      exit = e;
    });
    let wake: () => void = () => {};
    onInterrupt = () => wake();

    let reason: string | undefined;
    let lastError = "no response yet";
    try {
      for (;;) {
        if (interrupted) {
          reason = "interrupted";
          break;
        }
        if (exit) {
          reason = exit.error
            ? `could not start: ${exit.error}`
            : `server exited (${exit.code === null ? "signal" : `code ${exit.code}`}) before ${url} responded`;
          break;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          reason = `${url} did not respond with a non-5xx status within ${step.expect?.within ?? "60s"} (last: ${lastError})`;
          break;
        }
        try {
          const status = await probe(url, Math.min(2000, remaining));
          if (status < 500) break;
          lastError = `HTTP ${status}`;
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          lastError = e.code ?? e.message;
        }
        await Promise.race([
          sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now()))),
          r.exited,
          new Promise<void>((res) => {
            wake = res;
          }),
        ]);
      }
    } finally {
      onInterrupt = undefined;
      await terminate(r);
    }
    const base = {
      name: step.name,
      phase: step.phase,
      run: step.run,
      durationMs: Date.now() - start,
    };
    if (reason === undefined) return { ...base, status: "passed" };
    return { ...base, status: "failed", reason, outputTail: r.output.tail() };
  }

  const results: StepResult[] = [];
  const record = (result: StepResult) => {
    results.push(result);
    emit({ type: "end", result });
  };
  const skip = (step: VerifyStep, reason: string) =>
    record({
      name: step.name,
      phase: step.phase,
      run: step.run,
      status: "skipped",
      durationMs: 0,
      reason,
    });

  let setupFailed: string | undefined;
  try {
    for (const phase of PHASES) {
      for (const step of manifest.verify.filter((s) => s.phase === phase)) {
        const selected = selectionSkip(step);
        if (selected) {
          skip(step, selected);
          continue;
        }
        if (phase !== "teardown") {
          if (interrupted) {
            skip(step, "interrupted");
            continue;
          }
          if (setupFailed) {
            skip(step, `setup step ${setupFailed} failed`);
            continue;
          }
        }
        const cwd = resolve(projectDir, step.cwd ?? ".");
        const url = step.expect ? expandVars(step.expect.http, env) : undefined;
        emit({ type: "start", step, probe: url });
        let result: StepResult;
        if (!existsSync(cwd)) {
          result = {
            name: step.name,
            phase: step.phase,
            run: step.run,
            status: "failed",
            durationMs: 0,
            reason: `cwd ${step.cwd} does not exist`,
          };
        } else if (phase === "serve" && url) {
          result = await runServe(step, cwd, url);
        } else {
          result = await runCommand(step, cwd);
        }
        record(result);
        if (phase === "setup" && result.status === "failed") setupFailed = step.name;
      }
    }
  } finally {
    for (const pid of active) killGroup(pid, "SIGKILL");
    active.clear();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("exit", onExit);
  }

  const totals = { passed: 0, failed: 0, skipped: 0 };
  for (const r of results) totals[r.status]++;
  return {
    ok: totals.failed === 0 && !interrupted,
    projectDir,
    steps: results,
    warnings,
    totals,
  };
}
