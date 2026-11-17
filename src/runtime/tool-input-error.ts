/**
 * What the model and the app learn about a tool call whose arguments do not
 * match the tool's input schema: the field and what the schema expects,
 * never the value the model wrote.
 */

/** One schema violation: the field path and the schema's expectation. */
export interface ToolInputIssue {
  /** Dot path of the field (`items[2].id`), `(input)` for the whole input. */
  path: string;
  /** What the schema expects there, e.g. `expected format uuid`, `required`. */
  expected: string;
}

/** At most this many issues are named; the rest are counted. */
export const MAX_TOOL_INPUT_ISSUES = 5;
const MAX_PATH_CHARS = 80;
const MAX_EXPECTED_CHARS = 120;
const MAX_LIST_ITEMS = 10;

export const INVALID_TOOL_INPUT_INSTRUCTION = 'Correct the arguments and call the tool again; '
  + 'look up missing ids with a read tool instead of asking the user.';

/**
 * Handed to the app's `onError` for a model tool call with invalid input:
 * the tool, the field paths and the schema's expectations, no argument value.
 */
export class ToolInputValidationError extends Error {
  readonly toolName: string;
  readonly issues: ReadonlyArray<ToolInputIssue>;
  /** Issues beyond `issues` that were only counted. */
  readonly omittedIssues: number;

  constructor(toolName: string, issues: ReadonlyArray<ToolInputIssue>, omittedIssues = 0) {
    super(`Invalid input for tool ${toolName}: ${describeToolInputIssues(issues, omittedIssues)}`);
    this.name = 'ToolInputValidationError';
    this.toolName = toolName;
    this.issues = Object.freeze(issues.map((issue) => ({ ...issue })));
    this.omittedIssues = omittedIssues;
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function formatPath(path: unknown): string {
  if (!Array.isArray(path) || path.length === 0) return '(input)';
  const text = path.reduce<string>((joined, segment) => {
    if (typeof segment === 'number') return `${joined}[${segment}]`;
    const key = String(segment);
    return joined ? `${joined}.${key}` : key;
  }, '');
  return clip(text || '(input)', MAX_PATH_CHARS);
}

/** Schema-side values (enum options, literals), quoted and bounded. */
function formatValues(values: unknown): string | undefined {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const shown = values.slice(0, MAX_LIST_ITEMS).map((value) => clip(JSON.stringify(value) ?? String(value), 40));
  return values.length > MAX_LIST_ITEMS ? `${shown.join(', ')}, …` : shown.join(', ');
}

function limitText(what: string, side: 'at least' | 'at most', limit: unknown): string {
  const unit = what === 'string' ? ' characters' : what === 'array' ? ' items' : '';
  return `${what} must be ${side} ${String(limit)}${unit}`;
}

/** The expectation of one Ajv error (`createJsonSchemaLike`), from its keyword and schema-side params. */
function describeJsonSchemaExpectation(keyword: string, params: Record<string, unknown>, message: string): string {
  switch (keyword) {
    case 'required': return 'required';
    case 'type': return `expected ${String(params.type)}`;
    case 'format': return `expected format ${String(params.format)}`;
    case 'enum': {
      const values = formatValues(params.allowedValues);
      return values ? `expected one of ${values}` : 'value not allowed';
    }
    case 'const': return `expected ${clip(JSON.stringify(params.allowedValue) ?? 'a fixed value', 40)}`;
    case 'additionalProperties':
      return `unknown key not allowed: ${clip(String(params.additionalProperty), 40)}`;
    case 'minLength': return limitText('string', 'at least', params.limit);
    case 'maxLength': return limitText('string', 'at most', params.limit);
    case 'minItems': return limitText('array', 'at least', params.limit);
    case 'maxItems': return limitText('array', 'at most', params.limit);
    case 'minimum': case 'exclusiveMinimum': return `number must be ${String(params.comparison)} ${String(params.limit)}`;
    case 'maximum': case 'exclusiveMaximum': return `number must be ${String(params.comparison)} ${String(params.limit)}`;
    default: return message || 'invalid value';
  }
}

/**
 * The expectation of one Zod (v3 or v4) or JSON Schema issue. Known codes are
 * written from the issue's schema fields, so a message that quotes the
 * received value (Zod v3 enums) is never used; other messages are clipped.
 */
function describeExpectation(issue: Record<string, unknown>): string {
  const code = typeof issue.code === 'string' ? issue.code : undefined;
  const message = typeof issue.message === 'string' ? issue.message : '';
  if (code === undefined && typeof issue.keyword === 'string') {
    const params = typeof issue.params === 'object' && issue.params !== null ? issue.params as Record<string, unknown> : {};
    return describeJsonSchemaExpectation(issue.keyword, params, message);
  }
  switch (code) {
    case 'invalid_type': {
      const missing = issue.received === 'undefined' || /received undefined\b/.test(message);
      const expected = typeof issue.expected === 'string' ? issue.expected : undefined;
      if (missing) return expected ? `required (${expected})` : 'required';
      return expected ? `expected ${expected}` : 'wrong type';
    }
    case 'invalid_format':
      return typeof issue.format === 'string' ? `expected format ${issue.format}` : 'wrong format';
    case 'invalid_string':
      return typeof issue.validation === 'string' ? `expected format ${issue.validation}` : 'wrong format';
    case 'invalid_value':
    case 'invalid_enum_value': {
      const values = formatValues(issue.values ?? issue.options);
      return values ? `expected one of ${values}` : 'value not allowed';
    }
    case 'invalid_literal':
      return `expected ${clip(JSON.stringify(issue.expected) ?? 'a fixed value', 40)}`;
    case 'too_small':
    case 'too_big': {
      const bound = issue.minimum ?? issue.maximum;
      const what = typeof issue.origin === 'string' ? issue.origin : typeof issue.type === 'string' ? issue.type : 'value';
      const side = code === 'too_small' ? 'at least' : 'at most';
      return typeof bound === 'number' || typeof bound === 'bigint'
        ? limitText(what, side, bound)
        : `${what} ${code === 'too_small' ? 'too small' : 'too big'}`;
    }
    case 'unrecognized_keys': {
      const keys = Array.isArray(issue.keys)
        ? issue.keys.slice(0, MAX_LIST_ITEMS).map((key) => clip(String(key), 40)).join(', ')
        : '';
      return keys ? `unknown keys not allowed: ${keys}` : 'unknown keys not allowed';
    }
    default:
      return message ? message : 'invalid value';
  }
}

/** Issues of a Zod error or of a `createJsonSchemaLike` result, if the error carries any. */
export function toolInputIssues(error: unknown): { issues: ToolInputIssue[]; omitted: number } {
  const raw = typeof error === 'object' && error !== null && Array.isArray((error as { issues?: unknown }).issues)
    ? ((error as { issues: unknown[] }).issues).filter(
      (issue): issue is Record<string, unknown> => typeof issue === 'object' && issue !== null,
    )
    : [];
  const issues = raw.slice(0, MAX_TOOL_INPUT_ISSUES).map((issue) => ({
    // Ajv reports a missing property at its parent.
    path: formatPath(issue.keyword === 'required' && typeof (issue.params as { missingProperty?: unknown } | undefined)?.missingProperty === 'string'
      ? [...(Array.isArray(issue.path) ? issue.path : []), (issue.params as { missingProperty: string }).missingProperty]
      : issue.path),
    expected: clip(describeExpectation(issue), MAX_EXPECTED_CHARS),
  }));
  return { issues, omitted: Math.max(0, raw.length - issues.length) };
}

/** `playlistId: expected format uuid; kind: required. Correct the arguments …` */
export function describeToolInputIssues(issues: ReadonlyArray<ToolInputIssue>, omitted = 0): string {
  const named = issues.map((issue) => `${issue.path}: ${issue.expected}`).join('; ');
  const more = omitted > 0 ? `${named ? '; ' : ''}${omitted} more` : '';
  const head = named || more ? `${named}${more}.` : 'The arguments do not match the input schema.';
  return `${head} ${INVALID_TOOL_INPUT_INSTRUCTION}`;
}
