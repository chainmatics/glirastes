import type { ChatTriggerDefinition, CompletionSelectKind, ResolvedChatTrigger } from '../types.js';
import { inferMentionPrefix } from '../utils/mention-markup.js';

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

/**
 * One trigger with its defaults (`prefix` = char, `select` = `chip`). A plain
 * string is a char. Throws on an invalid char, prefix, select kind or types.
 */
export function normalizeTrigger(trigger: string | ChatTriggerDefinition): ResolvedChatTrigger {
  const definition = typeof trigger === 'string' ? { char: trigger } : trigger;
  const { char, label, prefix = char, select = 'chip', types } = definition;
  assertChar(char);
  const invalid = (rule: string) => new Error(`Invalid chat trigger ${JSON.stringify(char)}: ${rule}`);
  // The prefix is the pill's token in the text (`prefix + slug`); it must survive a send.
  if (typeof prefix !== 'string' || prefix.length === 0 || /\s/.test(prefix)) {
    throw invalid('`prefix` must be a non-empty string without whitespace');
  }
  if (!SELECT_KINDS.includes(select)) {
    throw invalid(`\`select\` must be one of ${SELECT_KINDS.join(', ')}`);
  }
  if (types !== undefined && !(Array.isArray(types) && types.every((type) => typeof type === 'string' && type.length > 0))) {
    throw invalid('`types` must be a list of non-empty mention types');
  }
  if (types?.includes('command')) {
    throw invalid('`types` cannot contain `command`; commands always use `/`');
  }
  return {
    char,
    prefix,
    select,
    ...(label !== undefined ? { label } : {}),
    ...(types !== undefined ? { types: [...types] } : {}),
  };
}

/** Prefix per claimed mention type; throws when two triggers claim one type. */
function prefixesByType(triggers: ReadonlyArray<ResolvedChatTrigger>): Map<string, string> {
  const owners = new Map<string, string>();
  const prefixes = new Map<string, string>();
  for (const trigger of triggers) {
    for (const type of trigger.types ?? []) {
      const owner = owners.get(type);
      if (owner !== undefined && owner !== trigger.char) {
        throw new Error(
          `Duplicate chat trigger type: ${JSON.stringify(type)} is claimed by ${JSON.stringify(owner)} and ${JSON.stringify(trigger.char)}`,
        );
      }
      owners.set(type, trigger.char);
      prefixes.set(type, trigger.prefix);
    }
  }
  return prefixes;
}

/**
 * The composer's trigger characters: `@` and `/`, every explicit definition
 * and every provider's char, in that order. An explicit definition wins; any
 * other char gets `{ prefix: char, select: 'chip' }`. Throws on an invalid
 * definition, a duplicate char and a mention type claimed by two triggers.
 */
export function resolveChatTriggers(
  defs: ReadonlyArray<ChatTriggerDefinition> | undefined,
  providers: ReadonlyArray<{ trigger: string }>,
): ResolvedChatTrigger[] {
  const resolved = new Map<string, ResolvedChatTrigger>();
  for (const char of BUILT_IN_CHARS) resolved.set(char, { char, prefix: char, select: 'chip' });

  const defined = new Set<string>();
  for (const definition of defs ?? []) {
    const trigger = normalizeTrigger(definition);
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
  const triggers = [...resolved.values()];
  prefixesByType(triggers);
  return triggers;
}

/**
 * The visible prefix of a sent mention by its type: the prefix of the trigger
 * whose `types` claim it, else `inferMentionPrefix(type)` (`/` for commands,
 * `@` otherwise). Without `types` it is exactly `inferMentionPrefix`.
 */
export function createMentionPrefixLookup(
  triggers: ReadonlyArray<string | ChatTriggerDefinition> | undefined,
): (type: string) => string {
  const prefixes = prefixesByType((triggers ?? []).map(normalizeTrigger));
  if (prefixes.size === 0) return inferMentionPrefix;
  return (type) => prefixes.get(type) ?? inferMentionPrefix(type);
}
