import type { AgentAuthStrategy } from '../types.js';

export type OutputFormat = 'skill' | 'mcp' | 'both';

export interface RecommendationInput {
  auth: AgentAuthStrategy;
  hasStreaming?: boolean;
  hasWebSocket?: boolean;
  multiAgentAccess?: boolean;
  toolCount?: number;
}

/**
 * Recommend the best output format (skill, mcp, or both) based on
 * the project's auth strategy, transport needs, and tool count.
 *
 * - OAuth2 → MCP (needs persistent token management)
 * - Streaming/WebSocket → MCP (needs persistent connection)
 * - Multi-agent → MCP (shared server benefits)
 * - Many tools (>20) → both (MCP for power users, skill for simple use)
 * - Default → skill (simpler, no server process needed)
 */
export function recommendOutputFormat(input: RecommendationInput): { format: OutputFormat; reason: string } {
  // OAuth2 → MCP (needs persistent auth state)
  if (input.auth.type === 'oauth2') {
    return { format: 'mcp', reason: 'OAuth2 requires persistent token management — MCP server handles refresh automatically' };
  }

  // Streaming/WebSocket → MCP
  if (input.hasStreaming || input.hasWebSocket) {
    return { format: 'mcp', reason: 'Streaming/WebSocket needs a persistent connection — MCP server is ideal' };
  }

  // Multi-agent → MCP
  if (input.multiAgentAccess) {
    return { format: 'mcp', reason: 'Multiple agents benefit from a shared MCP server instance' };
  }

  // Many tools → both (MCP for power users, skill for simple use)
  if (input.toolCount && input.toolCount > 20) {
    return { format: 'both', reason: 'Large tool count benefits from both formats — skill for quick setup, MCP for full access' };
  }

  // Default: skill (simpler)
  return { format: 'skill', reason: 'Simple REST API with standard auth works well as a skill file' };
}
