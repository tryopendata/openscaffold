import { Command } from "commander";
import { register as registerAdd } from "./commands/add.js";
import { printGuide } from "./commands/guide.js";
import { register as registerList } from "./commands/list.js";
import { register as registerNew } from "./commands/new.js";
import { register as registerShow } from "./commands/show.js";
import { register as registerValidate } from "./commands/validate.js";
import { register as registerVerify } from "./commands/verify.js";
import { OpenScaffoldError } from "./errors.js";
import { VERSION } from "./version.js";

const program = new Command()
  .name("openscaffold")
  .description("Agent-first project scaffolding. Run with no arguments for a guide.")
  .version(VERSION)
  .action(() => printGuide());

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

try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof OpenScaffoldError) {
    process.stderr.write(`error: ${err.message}\n`);
    if (err.hint) process.stderr.write(`hint: ${err.hint}\n`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
