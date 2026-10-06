export class ToolsUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolsUsageError';
  }
}

export interface ToolArgsSpec {
  flags: ReadonlyArray<string>;
  values: ReadonlyArray<string>;
  /** Most positional arguments (tool names, patterns, values); none by default. */
  positionals?: number;
}

export function parseToolArgs(
  argv: ReadonlyArray<string>,
  spec: ToolArgsSpec,
): { flags: Set<string>; values: Map<string, string>; positionals: string[] } {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith('--') && positionals.length < (spec.positionals ?? 0)) {
      positionals.push(argument);
      continue;
    }
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
  return { flags, values, positionals };
}
