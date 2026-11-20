import type { ChatTriggerDefinition, CompletionSelectKind, ResolvedChatTrigger } from '../types.js';

const SELECT_KINDS: ReadonlyArray<CompletionSelectKind> = ['chip', 'text', 'run', 'list'];

/** `@` and `/` always open a list, as before `triggers` existed. */
const BUILT_IN_CHARS = ['@', '/'] as const;

function assertChar(char: unknown): asserts char is string {
  if (typeof char !== 'string' || char.length !== 1 || /\s/.test(char)) {
    throw new Error(
      `Invalid chat trigger ${JSON.stringify(char)}: \`char\` must be exactly one character that is not whitespace`,
    );
  }
}

function resolveDefinition(definition: ChatTriggerDefinition): ResolvedChatTrigger {
  const { char, label, prefix = char, select = 'chip' } = definition;
  assertChar(char);
  // The prefix is the pill's token in the text (`prefix + slug`); it must survive a send.
  if (typeof prefix !== 'string' || prefix.length === 0 || /\s/.test(prefix)) {
    throw new Error(
      `Invalid chat trigger ${JSON.stringify(char)}: \`prefix\` must be a non-empty string without whitespace`,
    );
  }
  if (!SELECT_KINDS.includes(select)) {
    throw new Error(
      `Invalid chat trigger ${JSON.stringify(char)}: \`select\` must be one of ${SELECT_KINDS.join(', ')}`,
    );
  }
  return { char, prefix, select, ...(label !== undefined ? { label } : {}) };
}

/**
 * The composer's trigger characters: `@` and `/`, every explicit definition
 * and every provider's char, in that order. An explicit definition wins; any
 * other char gets `{ prefix: char, select: 'chip' }`. Throws on an invalid
 * char, prefix or select kind and on a duplicate definition.
 */
export function resolveChatTriggers(
  defs: ReadonlyArray<ChatTriggerDefinition> | undefined,
  providers: ReadonlyArray<{ trigger: string }>,
): ResolvedChatTrigger[] {
  const resolved = new Map<string, ResolvedChatTrigger>();
  for (const char of BUILT_IN_CHARS) resolved.set(char, { char, prefix: char, select: 'chip' });

  const defined = new Set<string>();
  for (const definition of defs ?? []) {
    const trigger = resolveDefinition(definition);
    if (defined.has(trigger.char)) {
      throw new Error(`Duplicate chat trigger definition: ${JSON.stringify(trigger.char)}`);
    }
    defined.add(trigger.char);
    resolved.set(trigger.char, trigger);
  }

  for (const { trigger: char } of providers) {
    assertChar(char);
    if (!resolved.has(char)) resolved.set(char, { char, prefix: char, select: 'chip' });
  }
  return [...resolved.values()];
}
