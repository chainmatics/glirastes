import { compareCodeUnits } from './canonical.js';
import { toolFinding } from './findings.js';
import type { McpToolName, ToolFinding } from './types.js';

/** An enabled endpoint tool as `createMcpEndpointCatalog()` lists it. */
export interface McpNameSubject {
  stableKey: string;
  /** The contract id; every catalog entry of the tool carries it as `definitionId`. */
  definitionId: string;
  /** The generated model name; with the contract id it is the default `{ id, name }`. */
  modelName: string;
  /** What `.glirastes/mcp-tool-names.json` keeps for the tool; without it the tool is listed under its defaults. */
  kept?: ReadonlyArray<McpToolName>;
}

const FIELDS = ['id', 'name'] as const;

type McpNameField = (typeof FIELDS)[number];

/** Per field: value -> the tools using it, and whether one of them got it from the names file. */
type Claims = Record<McpNameField, Map<string, Map<string, boolean>>>;

function claimsOf(tools: ReadonlyArray<McpNameSubject>, fallback: ReadonlySet<string>): Claims {
  const claims: Claims = { id: new Map(), name: new Map() };
  const claim = (field: McpNameField, value: string, stableKey: string, kept: boolean) => {
    const users = claims[field].get(value) ?? new Map<string, boolean>();
    users.set(stableKey, (users.get(stableKey) ?? false) || kept);
    claims[field].set(value, users);
  };
  for (const tool of tools) {
    const kept = fallback.has(tool.stableKey) ? undefined : tool.kept;
    // A grant by contract id must still name one tool, so the contract id is claimed even where the tool keeps other ids.
    claim('id', tool.definitionId, tool.stableKey, false);
    for (const entry of kept ?? [{ id: tool.definitionId, name: tool.modelName }]) {
      claim('id', entry.id, tool.stableKey, kept !== undefined);
      claim('name', entry.name, tool.stableKey, kept !== undefined);
    }
  }
  return claims;
}

/**
 * The catalog's one rule, applied before it is rendered: across the enabled
 * endpoint tools every MCP grant id and every MCP name is used once, kept
 * names and generated defaults together (the names file only guarantees that
 * for itself). A tool whose kept names collide with another tool's is reported
 * and listed under its generated names; that is checked again, because the
 * generated names it returns to can collide in turn.
 */
export function checkMcpNames(
  tools: ReadonlyArray<McpNameSubject>,
): { findings: ToolFinding[]; fallback: ReadonlySet<string> } {
  const fallback = new Set<string>();
  const findings: ToolFinding[] = [];
  for (;;) {
    const claims = claimsOf(tools, fallback);
    const problems = new Map<string, string[]>();
    for (const field of FIELDS) {
      for (const [value, users] of [...claims[field]].sort(([left], [right]) => compareCodeUnits(left, right))) {
        if (users.size < 2) continue;
        for (const [stableKey, kept] of users) {
          if (!kept) continue;
          const others = [...users.keys()].filter((other) => other !== stableKey).sort(compareCodeUnits);
          problems.set(stableKey, [
            ...problems.get(stableKey) ?? [],
            `MCP ${field} ${value} kept for ${stableKey} is also used by ${others.join(', ')}`,
          ]);
        }
      }
    }
    if (problems.size === 0) return { findings, fallback };
    for (const stableKey of [...problems.keys()].sort(compareCodeUnits)) {
      fallback.add(stableKey);
      findings.push(toolFinding('mcp-tool-names-invalid', 'warning', stableKey,
        `The ${problems.get(stableKey)!.join('; the ')}; ${stableKey} keeps its generated MCP names meanwhile.`));
    }
  }
}
