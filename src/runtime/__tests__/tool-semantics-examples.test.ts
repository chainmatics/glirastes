import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, type ToolRegistry } from '../../types.js';
import { createRegistryToolDiscovery, type ToolSearchSemanticsMap } from '../tool-discovery.js';
import { defaultIntentRouterFor } from '../../server/adapters/nextjs/default-intent-routing.js';

/**
 * Example sentences of `.glirastes/tool-semantics.json` must take part in the
 * tool search: the start set of a turn (default intent routing) and
 * `find_tools`. The query below shares no word with any tool's name,
 * description or synonyms; only an example sentence of `playlists_list` has it.
 */
const QUERY = 'Zeig mir meine Abspiellisten';
const EXAMPLES = ['Zeig mir meine Abspiellisten', 'Welche Abspiellisten habe ich?', 'Show my rundowns'];

function tool(id: string, description: string, method: string) {
  return defineTool({
    id,
    description,
    method,
    inputSchema: z.object({}),
    execute: async () => ({ success: true }),
  });
}

const registry: ToolRegistry = {
  playlists_list: tool('playlists.list', 'List playlists.', 'GET'),
  playlists_create: tool('playlists.create', 'Create a playlist.', 'POST'),
  designs_list: tool('designs.list', 'List designs.', 'GET'),
};

describe('examples of tool semantics in the tool search', () => {
  const semantics: ToolSearchSemanticsMap = { playlists_list: { synonyms: ['playlist overview'], examples: EXAMPLES } };

  it('find_tools finds a tool by a query only one of its example sentences matches', () => {
    const discovery = createRegistryToolDiscovery({ turnId: 't', registry, semantics });
    expect(discovery.search(QUERY).map((result) => result.name)).toContain('playlists_list');
    // Search-only: an example is never returned.
    expect(JSON.stringify(discovery.search(QUERY))).not.toContain('Abspiellisten');
  });

  it('the default intent router puts that tool into the start set', () => {
    const decision = defaultIntentRouterFor({ registry, semantics }).route({ text: QUERY });
    expect(decision.toolNames).toContain('playlists_list');
  });
});
