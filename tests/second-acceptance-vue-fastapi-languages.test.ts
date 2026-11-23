import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MockLanguageModelV3 } from 'ai/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runToolsPipeline, type ToolsPipelineResult } from '../src/codegen/tools/pipeline.js';
import { createRegistryToolDiscovery } from '../src/runtime/index.js';
import {
  assertBuiltSdk,
  bootFastapiApp,
  closeFastapiApps,
  copyApp,
  FIXTURE_TENANT_ID,
  pythonReady,
  removeCopiedApps,
  VUE_APP,
  VUE_GENERATED_MODULE,
  type BootedFastapiApp,
} from './support/tool-runtime.js';
import { artifactOf, chatBody, passingCheck, toolNamed } from './support/tool-sync.js';

/**
 * Model-free part of the second acceptance run for languages: the
 * Vue+FastAPI fixture names three UI languages (tools.json `languages`:
 * en, de, pl), declares titles at its endpoints (`x-glirastes-title`, one
 * of them German only) and one German title in tool-semantics.json. The
 * tests check the generated labels per language, the fallback, that the
 * Platform-bound setup artifact carries no translation, that the search
 * finds a tool by Polish words, and that the runtime words the chat in the
 * language the chat names in a request (`Content-Language`), with no
 * language code in the app.
 */
const PYTHON_READY = pythonReady();

type Json = Record<string, unknown>;
interface Labels { singular: string; plural: string; approval: string }

let root: string;
let app: BootedFastapiApp;
let refresh: ToolsPipelineResult;

beforeAll(async () => {
  if (!PYTHON_READY) return;
  assertBuiltSdk();
  root = await copyApp(VUE_APP, '.second-acceptance-languages-');
  refresh = await runToolsPipeline({ root, mode: 'write' });
  app = await bootFastapiApp(root);
}, 240_000);
afterAll(async () => {
  await closeFastapiApps();
  await removeCopiedApps();
});

async function contractsOf(): Promise<Array<{ definitionId: string; labels?: Record<string, Labels>; title?: Record<string, string> }>> {
  const file = JSON.parse(await readFile(join(root, '.glirastes/tool-contracts.json'), 'utf8')) as { tools: never[] };
  return file.tools;
}

const label = (text: string): Labels => ({ singular: text, plural: text, approval: text });

describe.skipIf(!PYTHON_READY)('second acceptance fixture: texts in three languages', () => {
  it('mixes endpoint titles and tool-semantics.json per language, the maintained entry first', async () => {
    await passingCheck(root);
    const tools = new Map((await contractsOf()).map((tool) => [tool.definitionId, tool] as const));
    // Endpoint: en, de, pl; tool-semantics.json: de. German comes from the entry.
    expect(tools.get('playlists.get')?.labels).toEqual({
      en: label('Show playlist'), de: label('Playlist öffnen'), pl: label('Pokaż playlistę'),
    });
    expect(tools.get('playlists.get')?.title).toEqual({ en: 'Show playlist', de: 'Playlist öffnen', pl: 'Pokaż playlistę' });
    expect(tools.get('playlists.delete')?.labels?.pl).toEqual(label('Usuń playlistę'));
    // A partial translation: German declared, English from the template, Polish falls back to English.
    expect(tools.get('channels.delete')?.labels).toEqual({
      en: label('Delete channels'), de: label('Kanal löschen'), pl: label('Delete channels'),
    });
    // A tool without any declaration: the English and German templates, Polish falls back to English.
    expect(tools.get('users.list')?.labels).toEqual({
      en: label('List users'), de: label('Users auflisten'), pl: label('List users'),
    });
  }, 120_000);

  it('reports the languages without an own label once per language, never failing the check', () => {
    const missing = refresh.findings.filter((finding) => finding.code === 'label-translation-missing');
    expect(missing.map((finding) => [finding.severity, finding.subjectRef])).toEqual([
      ['warning', '.glirastes/tools.json#languages.pl'],
    ]);
    expect(missing[0]!.message).toContain('channels.delete');
    expect(missing[0]!.message).not.toContain('playlists.get');
  });

  it('keeps every translation out of the setup artifact the Platform receives', async () => {
    const artifact = await artifactOf(root);
    expect(toolNamed(artifact, 'playlists.get').presentation).toEqual({ locale: 'en-US', ...label('Show playlist') });
    expect(toolNamed(artifact, 'channels.delete').presentation).toEqual({ locale: 'en-US', ...label('Delete channels') });
    const wire = JSON.stringify(artifact);
    for (const text of ['Pokaż playlistę', 'Usuń playlistę', 'Kanal löschen', 'Playlist öffnen', 'playlisty']) {
      expect(wire).not.toContain(text);
    }
  });

  it('exports the labels per language and indexes the Polish synonyms for the search only', async () => {
    const generated = await import(pathToFileURL(join(root, VUE_GENERATED_MODULE)).href) as {
      toolTexts: Record<string, { labels: Record<string, Labels> }>;
      toolSearchSemantics: Record<string, { synonyms?: string[] }>;
      toolCatalog: ReadonlyArray<{ modelName: string; description: string }>;
    };
    expect(generated.toolTexts.channels_delete?.labels.de).toEqual(label('Kanal löschen'));
    expect(generated.toolSearchSemantics.playlists_list?.synonyms).toEqual(['listy odtwarzania', 'playlisty']);
    // One description for the model, the English one; no translation reaches it.
    const list = generated.toolCatalog.find((tool) => tool.modelName === 'playlists_list');
    expect(list?.description).toBe('List your playlists with their items, optionally only one status.');
    const registry = app.turn({ authorization: `Bearer ${app.token}` }).registry;
    const discovery = createRegistryToolDiscovery({ turnId: randomUUID(), registry, semantics: generated.toolSearchSemantics });
    expect(discovery.search('listy odtwarzania')[0]?.name).toBe('playlists_list');
  });

});

/** A model that answers with nothing at all: the handler then writes its own text for a silent turn. */
function silentModel() {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  return new MockLanguageModelV3({ doStream: async () => ({
    stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage });
      controller.close();
    } }),
  }) });
}

/** The `data-tool-presentation` part of one turn, and the whole stream. */
async function turnIn(language: string | undefined): Promise<{ presentation: { locale: string; tools: Record<string, { label: string }> }; stream: string }> {
  const { createChatRuntime } = await import(pathToFileURL(join(root, 'runtime/chat.mjs')).href) as {
    createChatRuntime(options: Json): { server: Server };
  };
  const chat = createChatRuntime({ apiOrigin: () => app.apiOrigin, model: () => silentModel(), tenantId: FIXTURE_TENANT_ID });
  await new Promise<void>((listening) => chat.server.listen(0, '127.0.0.1', listening));
  try {
    const origin = `http://127.0.0.1:${(chat.server.address() as AddressInfo).port}`;
    const response = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${app.token}`,
        // What <glirastes-chat> sends by itself for the page's lang.
        ...(language ? { 'content-language': language } : {}),
      },
      body: chatBody('Hello'),
    });
    expect(response.status).toBe(200);
    const stream = await response.text();
    const line = stream.split('\n').find((entry) => entry.includes('"data-tool-presentation"'));
    if (!line) throw new Error('No data-tool-presentation part');
    const part = JSON.parse(line.replace(/^data: /, '')) as { data: { locale: string; tools: Record<string, { label: string }> } };
    return { presentation: part.data, stream };
  } finally {
    await new Promise<void>((closed) => chat.server.close(() => closed()));
  }
}

describe.skipIf(!PYTHON_READY)('second acceptance fixture: the chat in the request language', () => {
  it('words the tools in Polish where declared and in English where Polish is missing', async () => {
    const { presentation, stream } = await turnIn('pl-PL');
    expect(presentation.locale).toBe('pl-PL');
    expect(presentation.tools.playlists_delete).toEqual({ label: 'Usuń playlistę' });
    expect(presentation.tools.playlists_get).toEqual({ label: 'Pokaż playlistę' });
    expect(presentation.tools.channels_delete).toEqual({ label: 'Delete channels' });
    // The runtime's own Polish text (a partial table of the app) for a turn that said nothing.
    expect(stream).toContain('Nie udało mi się odpowiedzieć.');
  }, 60_000);

  it('words the tools in German, with the German title of tool-semantics.json', async () => {
    const { presentation, stream } = await turnIn('de');
    expect(presentation.locale).toBe('de');
    expect(presentation.tools.channels_delete).toEqual({ label: 'Kanal löschen' });
    expect(presentation.tools.playlists_get).toEqual({ label: 'Playlist öffnen' });
    expect(stream).toContain('Darauf habe ich gerade keine Antwort erzeugt.');
  }, 60_000);

  it('keeps the part of before for a request without a language: the manifest locale and its labels', async () => {
    const { presentation, stream } = await turnIn(undefined);
    expect(presentation.locale).toBe('en-US');
    expect(presentation.tools.playlists_get).toEqual({ label: 'Show playlist' });
    expect(presentation.tools.users_list).toEqual({ label: 'List users' });
    expect(stream).toContain('I did not produce an answer to that.');
  }, 60_000);
});
