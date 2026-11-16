import { modelFacingToolName, TOOL_NAME_PATTERN } from '../../runtime/local-tool-bindings.js';
import type { EndpointMethod } from '../../types.js';
import { compareCodeUnits, sha256Digest } from './canonical.js';
import { toolFinding } from './findings.js';
import type { ToolFinding } from './types.js';

const OPERATIONS: Readonly<Record<EndpointMethod, string>> = {
  GET: 'list',
  HEAD: 'head',
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
};

function words(segment: string): string[] {
  return segment.split(/[^A-Za-z0-9]+/).filter(Boolean);
}

function camel(parts: ReadonlyArray<string>): string {
  return parts.map((part, index) => (
    index === 0
      ? part.charAt(0).toLowerCase() + part.slice(1)
      : part.charAt(0).toUpperCase() + part.slice(1)
  )).join('');
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/** `<resource>.list|get|head|check|create|update|delete` from method and path. */
export function deriveDefinitionId(input: { method: EndpointMethod; path: string }): string {
  const segments = input.path.split('/').filter(Boolean);
  const rest = segments[0] === 'api' ? segments.slice(1) : segments;
  const statics = rest.filter((segment) => !segment.startsWith(':') && !segment.startsWith('*'));
  let resource = camel(statics.flatMap(words)) || 'root';
  if (!/^[a-z]/.test(resource)) {
    resource = `api${resource.charAt(0).toUpperCase()}${resource.slice(1)}`;
  }
  const last = rest[rest.length - 1];
  const item = last?.startsWith(':') === true;
  const operation = item && input.method === 'GET' ? 'get'
    : item && input.method === 'HEAD' ? 'check'
      : OPERATIONS[input.method];
  return `${resource}.${operation}`;
}

export interface DefinitionIdRequest {
  stableKey: string;
  method: EndpointMethod;
  path: string;
  explicitId?: string;
  /** Where the explicit id was declared, for the findings; `Contract id` by default. */
  explicitIdSource?: string;
}

/**
 * Explicit id (contract id or OpenAPI `x-glirastes-name`) → previous inventory
 * name → derived name, collision-free and order-independent. An explicit id
 * wins over the name a previous inventory kept. When that name belonged to a
 * different tool that still exists, the takeover stands and is reported as
 * `definition-id-reassigned`: whatever is matched by name (tool-semantics.json
 * entries without a stable key) now reaches the new holder.
 */
export function assignDefinitionIds(
  entries: ReadonlyArray<DefinitionIdRequest>,
  previousByKey: ReadonlyMap<string, string>,
): { ids: Map<string, string>; findings: ToolFinding[] } {
  const ids = new Map<string, string>();
  const owners = new Map<string, string>();
  const findings: ToolFinding[] = [];
  const sorted = [...entries].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey));
  const claim = (entry: DefinitionIdRequest, id: string) => {
    ids.set(entry.stableKey, id);
    owners.set(id, entry.stableKey);
  };
  const present = new Set(sorted.map((entry) => entry.stableKey));
  const previousHolders = new Map<string, string>();
  for (const [stableKey, name] of [...previousByKey].sort(([left], [right]) => compareCodeUnits(left, right))) {
    if (present.has(stableKey) && !previousHolders.has(name)) previousHolders.set(name, stableKey);
  }
  const takeovers: Array<{ entry: DefinitionIdRequest; declared: string; from: string }> = [];

  for (const entry of sorted) {
    if (entry.explicitId === undefined) continue;
    const declared = entry.explicitIdSource ?? 'Contract id';
    if (!TOOL_NAME_PATTERN.test(entry.explicitId)) {
      findings.push(toolFinding('definition-id-invalid', 'warning', entry.stableKey,
        `${declared} ${JSON.stringify(entry.explicitId)} is not a valid tool name; a derived name is used.`));
      continue;
    }
    const owner = owners.get(entry.explicitId);
    if (owner !== undefined) {
      findings.push(toolFinding('definition-id-conflict', 'error', entry.stableKey,
        `${declared} ${entry.explicitId} is already used by ${owner}.`));
      continue;
    }
    claim(entry, entry.explicitId);
    const from = previousHolders.get(entry.explicitId);
    if (from !== undefined && from !== entry.stableKey) takeovers.push({ entry, declared, from });
  }

  for (const entry of sorted) {
    if (ids.has(entry.stableKey)) continue;
    const previous = previousByKey.get(entry.stableKey);
    if (previous && TOOL_NAME_PATTERN.test(previous) && !owners.has(previous)) claim(entry, previous);
  }

  const groups = new Map<string, DefinitionIdRequest[]>();
  for (const entry of sorted.filter((candidate) => !ids.has(candidate.stableKey))) {
    const base = deriveDefinitionId(entry);
    groups.set(base, [...groups.get(base) ?? [], entry]);
  }
  for (const base of [...groups.keys()].sort(compareCodeUnits)) {
    const group = groups.get(base)!;
    if (group.length === 1 && !owners.has(base)) {
      claim(group[0]!, base);
      continue;
    }
    for (const entry of group) {
      const withMethod = `${base}${capitalize(entry.method)}`;
      const suffix = sha256Digest(entry.stableKey).slice(7, 15).replace(/[^A-Za-z0-9]/g, 'x');
      claim(entry, owners.has(withMethod) ? `${withMethod}${suffix}` : withMethod);
    }
  }

  for (const { entry, declared, from } of takeovers) {
    findings.push(toolFinding('definition-id-reassigned', 'warning', entry.stableKey,
      `${declared} ${entry.explicitId} on ${entry.stableKey} was the name of ${from}, which is now ${ids.get(from)}.`));
  }

  const modelOwners = new Map<string, string>();
  for (const [stableKey, id] of [...ids].sort(([left], [right]) => compareCodeUnits(left, right))) {
    const modelName = modelFacingToolName(id);
    const owner = modelOwners.get(modelName);
    if (owner !== undefined) {
      findings.push(toolFinding('definition-id-conflict', 'error', stableKey,
        `${id} collides with the tool of ${owner} after model-safe encoding.`));
    } else {
      modelOwners.set(modelName, stableKey);
    }
  }
  return { ids, findings };
}
