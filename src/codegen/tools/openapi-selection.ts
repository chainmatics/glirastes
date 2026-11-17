import { isValidMaxResultChars } from '../../runtime/result-limit.js';
import type { ExcludedTool } from './types.js';

/**
 * Which operations of an OpenAPI export become tools. `all` (the default):
 * every supported operation that no rule excludes. `opt-in`: only operations
 * marked `x-glirastes-tool: true`.
 */
export type OpenapiSelection = 'all' | 'opt-in';

/** Most distinct roles one tool may declare; the setup artifact bounds `allowedRoles` the same way. */
export const MAX_DECLARED_ROLES = 50;
const MAX_IDENTIFIER = 200;

type Operation = Readonly<Record<string, unknown>>;

/** `x-glirastes-tool` as written: `undefined` when absent, `'invalid'` for a value that is not a boolean (read as absent). */
export function toolMarkerOf(operation: Operation): boolean | 'invalid' | undefined {
  const value = operation['x-glirastes-tool'];
  if (value === undefined) return undefined;
  return typeof value === 'boolean' ? value : 'invalid';
}

/**
 * The selection step, shared by the tools generator and the container build.
 * It runs after every existing exclusion (unsupported method or path, default
 * rules, policy excludes, `x-glirastes-ignore`), so those keep their reason:
 * `x-glirastes-tool: false` excludes in both modes (`opted-out`), and with
 * `opt-in` every operation without `x-glirastes-tool: true` is `not-opted-in`.
 */
export function selectionExclusion(
  stableKey: string,
  operation: Operation,
  selection: OpenapiSelection = 'all',
): ExcludedTool | undefined {
  const marker = toolMarkerOf(operation);
  if (marker === false) return { stableKey, reason: 'opted-out', origin: 'code' };
  if (selection === 'opt-in' && marker !== true) return { stableKey, reason: 'not-opted-in', origin: 'code' };
  return undefined;
}

function identifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= MAX_IDENTIFIER ? text : undefined;
}

export type DeclaredValue<T> = { value: T } | { invalid: true } | undefined;

/** `x-glirastes-name`: any string goes on to the tool name check; another type is invalid. */
export function declaredName(operation: Operation): DeclaredValue<string> {
  const value = operation['x-glirastes-name'];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? { value } : { invalid: true };
}

/** `x-glirastes-group`: a non-empty identifier of at most 200 characters, trimmed. */
export function declaredGroup(operation: Operation): DeclaredValue<string> {
  const value = operation['x-glirastes-group'];
  if (value === undefined) return undefined;
  const group = identifier(value);
  return group === undefined ? { invalid: true } : { value: group };
}

/**
 * `x-glirastes-roles`: identifiers, de-duplicated and sorted; `[]` means no
 * additional restriction. Anything else (not an array, a non-string or empty
 * entry, more than 50 distinct roles) is invalid.
 */
export function declaredRoles(operation: Operation): DeclaredValue<string[]> {
  const value = operation['x-glirastes-roles'];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return { invalid: true };
  const roles = value.map(identifier);
  if (roles.some((role) => role === undefined)) return { invalid: true };
  const distinct = [...new Set(roles as string[])].sort();
  return distinct.length > MAX_DECLARED_ROLES ? { invalid: true } : { value: distinct };
}

/**
 * `x-glirastes-max-result-chars`: the upper bound of the tool's serialized
 * result, an integer from 1,000 to 200,000. Anything else is invalid.
 */
export function declaredMaxResultChars(operation: Operation): DeclaredValue<number> {
  const value = operation['x-glirastes-max-result-chars'];
  if (value === undefined) return undefined;
  return isValidMaxResultChars(value) ? { value } : { invalid: true };
}
