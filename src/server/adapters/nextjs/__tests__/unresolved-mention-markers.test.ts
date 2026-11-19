import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import type { EntityDeclarationsByTool } from '../../../../contracts/entity-declaration.js';
import { prepareModelMessages, type ModelInputBreakdown } from '../prepare-model-messages.js';

type Part = Record<string, unknown>;

const user = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage;
const assistant = (id: string, parts: Part[]): UIMessage =>
  ({ id, role: 'assistant', parts }) as UIMessage;
const toolPart = (name: string, id: string, input: unknown, output: unknown): Part => ({
  type: `tool-${name}`, toolCallId: id, state: 'output-available', input, output,
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const entities: EntityDeclarationsByTool = {
  playlists_list: { output: [{ type: 'playlist', id: 'playlist_id', name: 'displayName', path: 'data[]' }] },
  revisions_list: { output: [{ type: 'channel-revision', id: ['channelKey', 'rev'], path: 'revisions[]' }] },
};

const list = toolPart('playlists_list', 'c0', {}, {
  success: true,
  data: [{ playlist_id: uuid(1), displayName: 'Lobby Loop' }, { playlist_id: uuid(2), displayName: 'Evening' }],
});

async function breakdownOf(
  messages: UIMessage[],
  options: { entities?: EntityDeclarationsByTool; earlierMessages?: UIMessage[] } = {},
): Promise<ModelInputBreakdown> {
  let breakdown: ModelInputBreakdown | undefined;
  await prepareModelMessages(messages, { ...options, onBreakdown: (value) => { breakdown = value; } });
  return breakdown!;
}

describe('unresolved mention markers (onBreakdown / onModelInput)', () => {
  it('counts markers whose id the conversation never showed as a declared record, never their id or text', async () => {
    const messages = [
      user('u0', 'Show my playlists'),
      assistant('a0', [
        { type: 'step-start' }, list,
        // One exact id, one shortened, one with another type, one command marker (never counted).
        {
          type: 'text',
          text: `{{mention:playlist:${uuid(1)}:Lobby Loop}} and {{mention:playlist:${uuid(2).slice(0, 8)}:Evening}} `
            + `{{mention:channel:${uuid(1)}:Lobby Loop}} {{mention:command:help:Help}}`,
        },
      ]),
      user('u1', 'Rename the second'),
    ];
    const breakdown = await breakdownOf(messages, { entities });
    expect(breakdown.unresolvedMentionMarkers).toBe(2);
    expect(JSON.stringify(breakdown)).not.toContain(uuid(2).slice(0, 8));
  });

  it("takes the user's own @ mentions, composite keys and results outside the window as seen", async () => {
    const earlier = [
      user('e0', 'Show revisions'),
      assistant('e1', [{ type: 'step-start' }, toolPart('revisions_list', 'c9', {}, { revisions: [{ channelKey: 'lobby', rev: 4 }] })]),
    ];
    const messages = [
      user('u0', 'Open {{mention:playlist:pl-7:Morning}}'),
      assistant('a0', [{
        type: 'text',
        text: 'Opened {{mention:playlist:pl-7:Morning}} and {{mention:channel-revision:lobby/4:Rev 4}}, not {{mention:channel-revision:lobby/5:Rev 5}}.',
      }]),
      user('u1', 'ok'),
    ];
    expect((await breakdownOf(messages, { entities, earlierMessages: earlier })).unresolvedMentionMarkers).toBe(1);
  });

  it('counts every marker without declarations (the browser keeps them as text by default) and 0 without markers', async () => {
    const withMarker = [
      user('u0', 'Show my playlists'),
      assistant('a0', [{ type: 'step-start' }, list, { type: 'text', text: `{{mention:playlist:${uuid(1)}:Lobby Loop}}` }]),
      user('u1', 'thanks'),
    ];
    expect((await breakdownOf(withMarker)).unresolvedMentionMarkers).toBe(1);
    const plain = [user('u0', 'hi'), assistant('a0', [{ type: 'text', text: 'Hello.' }]), user('u1', 'x')];
    expect((await breakdownOf(plain, { entities })).unresolvedMentionMarkers).toBe(0);
  });
});
