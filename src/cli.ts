import { Command, CommanderError } from "commander";
import { register as registerAdd } from "./commands/add.js";
import { printGuide } from "./commands/guide.js";
import { register as registerList } from "./commands/list.js";
import { register as registerNew } from "./commands/new.js";
import { register as registerShow } from "./commands/show.js";
import { register as registerValidate } from "./commands/validate.js";
import { register as registerVerify } from "./commands/verify.js";
import { OpenScaffoldError } from "./errors.js";
import { printJson } from "./output.js";
import { VERSION } from "./version.js";

// A closed pipe (`openscaffold verify | head`) isn't an error. Drop further output to that
// stream and let the command finish, so verify still runs teardown and exits with its real code.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") throw err;
    stream.write = ((...args: unknown[]) => {
      const done = args.findLast((a) => typeof a === "function") as (() => void) | undefined;
      done?.();
      return true;
    }) as typeof stream.write;
  });
}

const args = process.argv.slice(2);
// Decided from argv rather than parsed options, so parse errors are reported as JSON too.
const json = args.includes("--json");

const program = new Command()
  .name("openscaffold")
  .description("Agent-first project scaffolding. Run with no arguments for a guide.")
  .version(VERSION)
  .showSuggestionAfterError()
  .exitOverride()
  .configureOutput({
    // In --json mode the error is printed once, as JSON, by the handler below.
    outputError: (text, write) => {
      if (!json) write(text);
    },
  });

for (const register of [
  registerList,
  registerShow,
  registerNew,
  registerAdd,
  registerVerify,
  registerValidate,
]) {
  register(program);
}

function fail(code: string, message: string, hint?: string): void {
  if (json) {
    printJson({ error: { code, message, hint: hint ?? null } });
  } else {
    process.stderr.write(`error: ${message}\n`);
    if (hint) process.stderr.write(`hint: ${hint}\n`);
  }
  process.exitCode = 1;
}

try {
  if (args.length === 0) printGuide();
  else await program.parseAsync();
} catch (err) {
  if (err instanceof OpenScaffoldError) {
    fail(err.code, err.message, err.hint);
  } else if (err instanceof CommanderError) {
    // --help and --version also arrive here, with exit code 0; commander already printed them.
    if (err.exitCode !== 0 && json) {
      printJson({
        error: { code: err.code, message: err.message.replace(/^error: /, ""), hint: null },
      });
    }
    process.exitCode = err.exitCode;
  } else if (json) {
    fail("internal", err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
  } else {
    throw err;
  }
}

// Exit once output is flushed, so nothing left pending (a slow registry download, a stray
// timer) keeps the process alive after the command has finished.
await Promise.all(
  [process.stdout, process.stderr].map(
    (stream) => new Promise<void>((done) => stream.write("", () => done())),
  ),
);
process.exit();
