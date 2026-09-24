import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { OpenScaffoldError } from "./errors.js";
import { type UserConfig, UserConfigSchema } from "./schema/index.js";

export function userConfigPath(home: string = homedir()): string {
  return join(home, ".openscaffold", "config.yaml");
}

/** Read ~/.openscaffold/config.yaml. A missing or empty file yields the defaults. */
export function loadUserConfig(home: string = homedir()): UserConfig {
  const file = userConfigPath(home);
  if (!existsSync(file)) return UserConfigSchema.parse({});

  let data: unknown;
  try {
    data = parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new OpenScaffoldError(
      "config_invalid",
      `${file} is not valid YAML: ${(err as Error).message}`,
      "Fix the YAML syntax or delete the file to use defaults.",
    );
  }

  const result = UserConfigSchema.safeParse(data ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new OpenScaffoldError(
      "config_invalid",
      `${file} is invalid: ${issues}`,
      `Valid keys: ${Object.keys(UserConfigSchema.shape).join(", ")}. Fix or remove the listed fields.`,
    );
  }
  return result.data;
}
