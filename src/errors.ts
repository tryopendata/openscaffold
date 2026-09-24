/**
 * User-facing error. `hint` tells the reader (usually an agent) what to do next.
 * Anything that isn't an OpenScaffoldError is treated as a bug and printed with a stack.
 */
export class OpenScaffoldError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "OpenScaffoldError";
  }
}
