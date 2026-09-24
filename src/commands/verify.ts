import type { Command } from "commander";
import { printJson, println, warn } from "../output.js";
import { collect } from "../scaffold.js";
import { runVerify, type StepResult, signalExitCode, type VerifyEvent } from "../verify.js";

interface VerifyFlags {
  dir: string;
  skipTag?: string[];
  all?: boolean;
  only?: string[];
  json?: boolean;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusLine(r: StepResult): string {
  if (r.status === "skipped") return `  skip  ${r.name}: ${r.reason}`;
  if (r.status === "passed") return `  ok    ${r.name} (${seconds(r.durationMs)})`;
  const why = r.reason ?? `exit ${r.exitCode}`;
  return `  FAIL  ${r.name}: ${why} (${seconds(r.durationMs)})`;
}

function printEvent(e: VerifyEvent): void {
  switch (e.type) {
    case "warning":
      warn(e.message);
      break;
    case "start":
      println(
        e.probe
          ? `$ ${e.step.run}  [probe ${e.probe}, up to ${e.step.expect?.within}]`
          : `$ ${e.step.run}`,
      );
      break;
    case "end":
      println(statusLine(e.result));
      if (e.result.status === "failed" && e.result.outputTail) {
        for (const line of e.result.outputTail.split("\n")) println(`    | ${line}`);
      }
      break;
    case "output":
      break;
  }
}

export function register(program: Command): void {
  program
    .command("verify")
    .description(
      "Run the project's verify steps from .openscaffold/manifest.yaml (runs shell commands; each is printed first)",
    )
    .option("--dir <path>", "project directory", ".")
    .option(
      "--skip-tag <tags>",
      "skip steps with these tags (comma-separated, repeatable)",
      collect,
    )
    .option("--all", "include steps the sandbox preset skips (tagged prod)")
    .option(
      "--only <names>",
      "run only these check/serve steps (comma-separated, repeatable; setup and teardown still run)",
      collect,
    )
    .option("--json", "print the report as JSON")
    .action(async (flags: VerifyFlags) => {
      const report = await runVerify({
        projectDir: flags.dir,
        skipTags: flags.skipTag,
        all: flags.all,
        only: flags.only,
        onEvent: flags.json ? undefined : printEvent,
      });
      if (!report.ok) process.exitCode = report.signal ? signalExitCode(report.signal) : 1;
      if (flags.json) {
        printJson(report);
        return;
      }
      const { passed, failed, skipped } = report.totals;
      println();
      println(`verify: ${passed} passed, ${failed} failed, ${skipped} skipped`);
      if (!report.ok) {
        println(
          "next: fix the failures above and re-run `openscaffold verify`; don't weaken the steps",
        );
      }
    });
}
