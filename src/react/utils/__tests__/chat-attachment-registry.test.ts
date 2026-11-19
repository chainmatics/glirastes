// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../types.js';
import { createMemoryAttachmentStore } from '../attachment-blob-store.js';
import {
  chatAttachmentFormData,
  getChatAttachment,
  setActiveChatAttachmentSource,
} from '../chat-attachment-registry.js';

const ID = 'att_abcdefghijklmnop';
const dataUrl = `data:text/plain;base64,${btoa('hello')}`;
const withFile = (url: string): ChatMessage[] => [{
  id: 'm', role: 'user',
  parts: [{ type: 'file', mediaType: 'text/plain', url, filename: 'a.txt', providerMetadata: { glirastes: { attachmentId: ID } } }],
} as unknown as ChatMessage];
function readText(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.readAsText(blob);
  });
}

describe('chat attachment registry', () => {
  afterEach(() => setActiveChatAttachmentSource(null));

  it('resolves an attachment of the running chat before it is stored', async () => {
    setActiveChatAttachmentSource({ conversationId: 'A', messages: () => withFile(dataUrl), store: createMemoryAttachmentStore() });
    const found = await getChatAttachment(ID);
    expect(found?.name).toBe('a.txt');
    expect(found?.mediaType).toBe('text/plain');
    expect(await readText(found!.blob)).toBe('hello');
  });

  it('falls back to the store when the messages only have an empty url', async () => {
    const store = createMemoryAttachmentStore();
    await store.put('A', ID, { blob: new Blob(['stored'], { type: 'text/plain' }), name: 'a.txt', mediaType: 'text/plain' });
    setActiveChatAttachmentSource({ conversationId: 'A', messages: () => withFile(''), store });
    expect(await readText((await getChatAttachment(ID))!.blob)).toBe('stored');
  });

  it('does not resolve an id of another conversation', async () => {
    const store = createMemoryAttachmentStore();
    await store.put('B', ID, { blob: new Blob(['x']), name: 'a.txt', mediaType: 'text/plain' });
    setActiveChatAttachmentSource({ conversationId: 'A', messages: () => [], store });
    expect(await getChatAttachment(ID)).toBeNull();
  });

  it('gives null for a malformed id without touching the store', async () => {
    const store = createMemoryAttachmentStore();
    const get = vi.spyOn(store, 'get');
    setActiveChatAttachmentSource({ conversationId: 'A', messages: () => [], store });
    expect(await getChatAttachment('../etc')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('gives null without a source and works without a store', async () => {
    expect(await getChatAttachment(ID)).toBeNull();
    setActiveChatAttachmentSource({ conversationId: 'A', messages: () => [], store: null });
    expect(await getChatAttachment(ID)).toBeNull();
  });

  it('builds FormData with the original name and type', async () => {
    setActiveChatAttachmentSource({ conversationId: 'A', messages: () => withFile(dataUrl), store: null });
    const form = await chatAttachmentFormData(ID);
    const file = form!.get('file') as File;
    expect(file.name).toBe('a.txt');
    expect(file.type).toBe('text/plain');
    expect(await chatAttachmentFormData('nope')).toBeNull();
  });
});
