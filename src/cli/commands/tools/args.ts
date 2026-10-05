export class ToolsUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolsUsageError';
  }
}

export function parseToolArgs(
  argv: ReadonlyArray<string>,
  spec: { flags: ReadonlyArray<string>; values: ReadonlyArray<string> },
): { flags: Set<string>; values: Map<string, string> } {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (spec.flags.includes(argument)) {
      flags.add(argument);
      continue;
    }
    if (spec.values.includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new ToolsUsageError(`${argument} needs a value.`);
      values.set(argument, value);
      index += 1;
      continue;
    }
    throw new ToolsUsageError(`Unknown argument ${argument}.`);
  }
  return { flags, values };
}
