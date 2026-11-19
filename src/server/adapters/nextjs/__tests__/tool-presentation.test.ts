import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../../../types.js';
import {
  agentRevision,
  localLimits,
  manifestRevision,
  policyRevision,
  principal,
} from '../../../../runtime/__tests__/turn-snapshot.test.js';
import { authorizedTurnToolIds } from '../../../../runtime/authorization.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import * as commands from './command-fixtures.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { toolPresentationOf } from '../tool-presentation.js';

const presentation = { locale: 'de-DE', singular: 'Aufgabe', plural: 'Aufgaben', approval: 'Aufgaben auflisten?' };

/** The fixture manifest with a wording on its first tool, as `glirastes tools refresh` derives one for every tool. */
const worded = {
  ...manifestRevision,
  tools: manifestRevision.tools.map((tool, index) => (index === 0
    ? { ...tool, modelName: 'list_tasks', presentation }
    : tool)),
};

const everyTool = new Set(manifestRevision.tools.map((tool) => tool.toolId));

describe('the wording the chat UI gets for the tools of a turn', () => {
  it('names every worded tool by its model name, without the question mark of the confirmation', () => {
    expect(toolPresentationOf(worded, everyTool)).toEqual({
      locale: 'de-DE',
      tools: { list_tasks: { label: 'Aufgaben auflisten' } },
    });
  });

  it('falls back to the tool name when the manifest has no model name', () => {
    const tool = { ...worded.tools[0]!, modelName: undefined };
    expect(Object.keys(toolPresentationOf({ ...worded, tools: [tool] }, everyTool)!.tools)).toEqual([tool.name]);
  });

  it('is nothing for a manifest without wordings', () => {
    expect(toolPresentationOf({ ...worded, tools: worded.tools.map(({ presentation: _dropped, ...tool }) => tool) }, everyTool)).toBeNull();
    expect(toolPresentationOf(undefined, everyTool)).toBeNull();
  });

  it('is nothing when the principal may use none of the worded tools', () => {
    expect(toolPresentationOf(worded, new Set())).toBeNull();
  });
});

describe('the wording per language (toolTexts)', () => {
  const labels = (text: string) => ({ singular: text, plural: text, approval: `${text}?` });
  const texts = { list_tasks: { labels: { en: labels('List tasks'), de: labels('Aufgaben zeigen'), pl: labels('Pokaż zadania') } } };

  it('words a tool in the turn language, the manifest where it speaks that language', () => {
    expect(toolPresentationOf(worded, everyTool, { texts, locale: 'pl-PL' }))
      .toEqual({ locale: 'pl-PL', tools: { list_tasks: { label: 'Pokaż zadania' } } });
    // The manifest presentation is German (a Platform revision may have curated it): it wins for German.
    expect(toolPresentationOf(worded, everyTool, { texts, locale: 'de-AT' }))
      .toEqual({ locale: 'de-AT', tools: { list_tasks: { label: 'Aufgaben auflisten' } } });
    // A long confirmation question stays, as in the part without languages.
    const long = { list_tasks: { labels: { pl: { singular: 'Zadania', plural: 'Zadania', approval: `${'Czy '.repeat(80)}?` } } } };
    expect(toolPresentationOf(worded, everyTool, { texts: long, locale: 'pl' })?.tools.list_tasks?.label).toBe('Czy '.repeat(80).trim());
    // No French labels: English.
    expect(toolPresentationOf(worded, everyTool, { texts, locale: 'fr' })?.tools).toEqual({ list_tasks: { label: 'List tasks' } });
  });

  it('keeps the part of before without a turn language or without labels', () => {
    expect(toolPresentationOf(worded, everyTool, { texts })).toEqual(toolPresentationOf(worded, everyTool));
    // Two tools worded in different locales: each keeps its own manifest label.
    const mixed = {
      ...worded,
      tools: worded.tools.map((tool, index) => (index === 1
        ? { ...tool, modelName: 'other_tool', presentation: { locale: 'en-US', singular: 'Other', plural: 'Others', approval: 'Run other?' } }
        : tool)),
    };
    const withOther = { ...texts, other_tool: { labels: { de: labels('Anderes') } } };
    expect(toolPresentationOf(mixed, everyTool, { texts: withOther })).toEqual(toolPresentationOf(mixed, everyTool));
    expect(toolPresentationOf(worded, everyTool, { locale: 'pl' })).toEqual(toolPresentationOf(worded, everyTool));
  });
});

describe('the wording for the principal of a turn', () => {
  const wording = (approval: string) => ({ locale: 'de-DE', singular: 'Aufgabe', plural: 'Aufgaben', approval });
  const wordedCommands = {
    ...commands.manifestRevision,
    tools: commands.manifestRevision.tools.map((tool) => ({
      ...tool,
      presentation: wording(tool.toolId === commands.LIST_TASKS_ID ? 'Aufgaben auflisten' : 'Aufgabe archivieren?'),
    })),
  };
  const labels = (options: {
    roles?: string[];
    listRoles?: string[];
    archiveEnabled?: boolean;
    revokedToolIds?: string[];
  } = {}) => {
    const snapshot = createTurnSnapshot({
      turnId: 'turn-1',
      agentRevision: commands.agentRevision,
      manifestRevision: wordedCommands,
      policyRevision: commands.policyRevision({
        ...(options.listRoles ? { listRoles: options.listRoles } : {}),
        ...(options.archiveEnabled === undefined ? {} : { archiveEnabled: options.archiveEnabled }),
      }),
      principal: commands.principal(),
      localLimits: commands.localLimits,
    });
    const allowed = authorizedTurnToolIds({
      snapshot,
      principal: commands.principal(options.roles),
      revocations: options.revokedToolIds ? [{
        revocationId: '019fb710-0000-7000-8000-0000000000f1',
        environmentId: snapshot.manifestRevision.environmentId,
        effectiveAt: '2026-10-05T08:00:00.000Z',
        reasonCode: 'incident',
        toolIds: options.revokedToolIds,
        agentRevisionIds: [],
        policyRevisionIds: [],
        signature: { algorithm: 'Ed25519', keyId: 'key-1', value: 'c2lnbmF0dXJl' },
      }] : [],
    });
    return Object.keys(toolPresentationOf(snapshot.manifestRevision, allowed)?.tools ?? {});
  };

  it('names the tools of a role the principal has, and unrestricted tools', () => {
    expect(labels({ roles: ['member'], listRoles: ['member'] })).toEqual(['tasks.list', 'tasks.archive']);
  });

  it('leaves out a tool restricted to a role the principal does not have', () => {
    expect(labels({ roles: ['viewer'], listRoles: ['member'] })).toEqual(['tasks.archive']);
  });

  it('leaves out a revoked tool', () => {
    expect(labels({ revokedToolIds: [commands.ARCHIVE_TASK_ID] })).toEqual(['tasks.list']);
  });

  it('leaves out a tool the policy disables', () => {
    expect(labels({ archiveEnabled: false })).toEqual(['tasks.list']);
  });
});

describe('a managed chat turn', () => {
  const request = () => new Request('https://tasks.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ id: 'message-1', role: 'user', parts: [{ type: 'text', text: 'Hallo' }] }] }),
  });
  const model = () => new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Hallo' },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        },
      ]),
    }),
  });
  const tools = {
    list_tasks: defineTool({
      id: agentRevision.toolAllowlist[0]!,
      description: 'List tasks.',
      inputSchema: z.object({}),
      execute: async () => ({ tasks: [] }),
    }),
  };

  it('sends the wording of its tools ahead of the answer', async () => {
    const handler = createAiChatHandler({
      tools,
      model: model(),
      systemPrompt: 'Assistant',
      managedRuntime: {
        resolvePrincipal: async () => principal,
        resolveTurnSnapshot: async ({ turnId }) => createTurnSnapshot({
          turnId, agentRevision, manifestRevision: worded, policyRevision, principal, localLimits,
        }),
      },
    });

    const body = await (await handler(request())).text();

    expect(body).toContain('"type":"data-tool-presentation"');
    expect(body).toContain('"list_tasks":{"label":"Aufgaben auflisten"}');
    expect(body.indexOf('data-tool-presentation')).toBeLessThan(body.indexOf('text-delta'));
    expect(body).toContain(
      'data: {"type":"data-tool-presentation","data":{"locale":"de-DE","tools":{"list_tasks":{"label":"Aufgaben auflisten"}}},"transient":true}',
    );
  });

  const pinnedFor = (roles: string[], allowedRoles: string[]) => createTurnSnapshot({
    turnId: 'ai-message-1',
    agentRevision,
    manifestRevision: worded,
    policyRevision: {
      ...policyRevision,
      toolPolicies: policyRevision.toolPolicies.map((policy) => ({ ...policy, allowedRoles })),
    },
    principal: { ...principal, roles },
    localLimits,
  });

  it('names no tool the current principal lost the role for, although the turn was pinned with it', async () => {
    const pinned = pinnedFor(['admin'], ['admin']);
    const handler = createAiChatHandler({
      tools,
      model: model(),
      systemPrompt: 'Assistant',
      managedRuntime: {
        resolvePrincipal: async () => ({ ...principal, roles: ['viewer'] }),
        resolveTurnSnapshot: async () => pinned,
      },
    });

    expect(await (await handler(request())).text()).not.toContain('data-tool-presentation');
  });

  it('names a tool without role restriction for any principal', async () => {
    const pinned = pinnedFor(['viewer'], []);
    const handler = createAiChatHandler({
      tools,
      model: model(),
      systemPrompt: 'Assistant',
      managedRuntime: {
        resolvePrincipal: async () => ({ ...principal, roles: ['viewer'] }),
        resolveTurnSnapshot: async () => pinned,
      },
    });

    expect(await (await handler(request())).text()).toContain('"list_tasks":{"label":"Aufgaben auflisten"}');
  });

  it('sends none without a pinned tool state', async () => {
    const handler = createAiChatHandler({ tools: {}, model: model(), systemPrompt: 'Assistant' });

    expect(await (await handler(request())).text()).not.toContain('data-tool-presentation');
  });
});
