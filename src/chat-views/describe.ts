/**
 * Renders a component manifest as the `render_view` tool description: usage
 * rules, the reference grammar and one compact signature line per component.
 */
import type {
  ChatComponentManifest,
  ChatComponentManifestEntry,
} from '../contracts/chat-view.js';

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  const?: unknown;
  format?: string;
  description?: string;
  items?: JsonSchema;
  maxItems?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: JsonSchema | boolean;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};

/**
 * The fixed system prompt rule the chat handler adds while `render_view` is
 * offered (`chatViews.promptRule` replaces or switches it off). A tool
 * description alone did not change the model's answer format; the system
 * prompt is where it takes answer-format rules.
 */
export const CHAT_VIEW_PROMPT_RULE =
  'Answer format: when an answer would list 4 or more like records, compare items or give a status overview, call render_view instead of writing a text or Markdown list or table. After the view add at most one short sentence and do not repeat the view\'s data in text. Never use a view for a single value, a confirmation or a question.';

const RULES = [
  'Renders one view in the chat. Use it instead of a text or Markdown list or table for ≥ 4 like records, a comparison or a status overview, and keep the text after it to one short sentence. Never for single values, confirmations or questions; never just to wrap a single result that already has its own tool-result renderer. One view per turn.',
  'Spec: {root, elements:{<id>:{type, props, children?:[<id>]}}, caption?}. Each component lists its props; "?" optional, ":ref" only a reference, "|ref" a literal or a reference.',
];

const GRAMMAR = [
  'Reference a tool result: {"$ref":"<toolCallId>","path":"data[].name"} (same path grammar as read_result; ref[] = a list path).',
  'Inside a Table cell element: {"$item":"<field>"} reads the current row.',
  'Stat.value only: {"$count":<ref>} or {"$sum":<ref>}; {"$said":"<text>","basis":<ref>} only if no operator fits.',
];

function typeOf(schema: JsonSchema, path: string, entry: ChatComponentManifestEntry): string {
  if (entry.refOnly.includes(path)) return schema.type === 'array' ? 'ref[]' : 'ref';
  const base = plainType(schema, path, entry);
  return entry.bindable.includes(path) ? `${base}|ref` : base;
}

function plainType(schema: JsonSchema, path: string, entry: ChatComponentManifestEntry): string {
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value).replace(/"/g, "'")).join('|');
  if (schema.const !== undefined) return JSON.stringify(schema.const).replace(/"/g, "'");
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) {
    return [...new Set(variants.map((variant) => plainType(variant, path, entry)))].join('|');
  }
  switch (schema.type) {
    case 'string':
      if (schema.description?.startsWith('#')) return schema.description;
      return schema.format ?? 'str';
    case 'number':
    case 'integer':
      return 'num';
    case 'boolean':
      return 'bool';
    case 'null':
      return 'null';
    case 'array': {
      const inner = schema.items ? typeOf(schema.items, `${path}[]`, entry) : 'any';
      return `[${inner}]${schema.maxItems !== undefined ? `≤${schema.maxItems}` : ''}`;
    }
    case 'object':
      if (schema.properties) return `{${propList(schema, path, entry)}}`;
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        return `{key:${typeOf(schema.additionalProperties, `${path}.*`, entry)}}`;
      }
      return 'obj';
    default:
      return 'any';
  }
}

function propList(schema: JsonSchema, path: string, entry: ChatComponentManifestEntry): string {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {})
    .map(([name, prop]) => {
      const propPath = path ? `${path}.${name}` : name;
      const type = typeOf(prop, propPath, entry);
      return `${name}${required.has(name) ? '' : '?'}${type === 'str' ? '' : `:${type}`}`;
    })
    .join(', ');
}

function signature(entry: ChatComponentManifestEntry): string {
  const props = propList(entry.props as JsonSchema, '', entry);
  const children = entry.children === 'none' ? '' : ' +children';
  const use = entry.whenToUse ? ` Use when: ${entry.whenToUse}.` : '';
  return `${entry.id}(${props})${children} – ${entry.description}.${use}`;
}

export function describeChatCatalog(manifest: ChatComponentManifest): string {
  return [...RULES, ...GRAMMAR, 'Components:', ...manifest.components.map(signature)].join('\n');
}
