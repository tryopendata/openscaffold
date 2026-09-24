/** Output helpers. Every read command supports --json; human output is written for agents to act on. */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function println(text = ""): void {
  process.stdout.write(`${text}\n`);
}

export function warn(text: string): void {
  process.stderr.write(`warning: ${text}\n`);
}
