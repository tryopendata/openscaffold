// Writes JSON Schema versions of the zod schemas to schema/ for editor autocomplete.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  FragmentMetaSchema,
  ManifestSchema,
  StackMetaSchema,
  UserConfigSchema,
} from "../src/schema/index.js";

const out = join(import.meta.dirname, "..", "schema");
const schemas = {
  stack: StackMetaSchema,
  fragment: FragmentMetaSchema,
  config: UserConfigSchema,
  manifest: ManifestSchema,
};

for (const [name, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  writeFileSync(join(out, `${name}.schema.json`), `${JSON.stringify(json, null, 2)}\n`);
  console.log(`schema/${name}.schema.json`);
}
