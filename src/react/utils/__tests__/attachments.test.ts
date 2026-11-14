// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../types.js';
import {
  fileToDataUrl,
  limitRequestAttachments,
  omitAttachmentData,
  readAttachments,
  resolveAttachmentOptions,
  validateFiles,
} from '../attachments.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (name = 'a.png', size = PNG.length) => {
  const bytes = new Uint8Array(size);
  bytes.set(PNG);
  return new File([bytes], name, { type: 'image/png' });
};
const options = resolveAttachmentOptions(true)!;

describe('resolveAttachmentOptions', () => {
  it('is off without options and on with true or an object', () => {
    expect(resolveAttachmentOptions(undefined)).toBeNull();
    expect(resolveAttachmentOptions(false)).toBeNull();
    expect(resolveAttachmentOptions({ enabled: false })).toBeNull();
    expect(resolveAttachmentOptions(true)).toMatchObject({ maxFiles: 10, maxFileBytes: 20_000_000 });
    expect(resolveAttachmentOptions({ maxFiles: 2 })).toMatchObject({ maxFiles: 2 });
  });
});

describe('validateFiles', () => {
  it('accepts allowed files within the count', () => {
    expect(validateFiles([png()], 0, options)).toEqual({ accepted: [png()], error: null });
  });

  it('refuses a type outside the allow-list and keeps the others', () => {
    const svg = new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' });
    const result = validateFiles([svg, png()], 0, options);
    expect(result.accepted.map((file) => file.name)).toEqual(['a.png']);
    expect(result.error).toEqual({ code: 'type', name: 'x.svg' });
  });

  it('refuses files beyond maxFiles, counting the ones already attached', () => {
    const result = validateFiles([png('1.png'), png('2.png')], 9, options);
    expect(result.accepted.map((file) => file.name)).toEqual(['1.png']);
    expect(result.error).toEqual({ code: 'too-many', count: 10 });
  });
});

describe('fileToDataUrl', () => {
  it('reads a blob as a base64 data URL of its type', async () => {
    expect(await fileToDataUrl(png())).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`);
  });
});

describe('readAttachments', () => {
  it('reads accepted files into attachments with a preview for images', async () => {
    const pdf = new File(['%PDF-1.7'], 'doc.pdf', { type: 'application/pdf' });
    const { attachments, error } = await readAttachments([png(), pdf], 0, options);
    expect(error).toBeNull();
    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toMatchObject({ name: 'a.png', mediaType: 'image/png', size: 8 });
    expect(attachments[0]!.url).toMatch(/^data:image\/png;base64,/);
    expect(attachments[0]!.previewUrl).toBe(attachments[0]!.url);
    expect(attachments[1]!.previewUrl).toBeUndefined();
    expect(attachments[0]!.id).not.toBe(attachments[1]!.id);
  });

  it('applies prepare before the size check', async () => {
    const prepare = vi.fn(async () => new Blob([PNG], { type: 'image/png' }));
    const { attachments, error } = await readAttachments([png('big.png', 5_000)], 0, { ...options, maxFileBytes: 100, prepare });
    expect(prepare).toHaveBeenCalledOnce();
    expect(error).toBeNull();
    expect(attachments[0]).toMatchObject({ name: 'big.png', size: 8 });
  });

  it('refuses a prepared file that is still too large', async () => {
    const { attachments, error } = await readAttachments([png('big.png', 5_000)], 0, { ...options, maxFileBytes: 100 });
    expect(attachments).toHaveLength(0);
    expect(error).toEqual({ code: 'too-large', name: 'big.png', maxBytes: 100 });
  });

  it('reports a failing prepare as a read failure', async () => {
    const { error } = await readAttachments([png()], 0, { ...options, prepare: () => { throw new Error('x'); } });
    expect(error).toEqual({ code: 'read-failed', name: 'a.png' });
  });
});

const fileMessage = (id: string, url: string, filename = `${id}.png`): ChatMessage => ({
  id, role: 'user', parts: [{ type: 'text', text: id }, { type: 'file', mediaType: 'image/png', url, filename }],
});
const reply = (id: string): ChatMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text: 'ok' }] });

describe('limitRequestAttachments', () => {
  it('keeps files only in the two most recent user messages', () => {
    const messages = [fileMessage('u1', 'data:x'), reply('a1'), fileMessage('u2', 'data:y'), reply('a2'), fileMessage('u3', 'data:z')];
    const limited = limitRequestAttachments(messages);
    expect(limited[0]!.parts).toEqual([{ type: 'text', text: 'u1' }, { type: 'text', text: '[attachment: u1.png]' }]);
    expect(limited[2]).toBe(messages[2]);
    expect(limited[4]).toBe(messages[4]);
  });

  it('always replaces omitted files', () => {
    const limited = limitRequestAttachments([fileMessage('u1', '')]);
    expect(limited[0]!.parts[1]).toEqual({ type: 'text', text: '[attachment: u1.png]' });
  });

  it('returns the same array when nothing changes', () => {
    const messages = [reply('a1')];
    expect(limitRequestAttachments(messages)).toBe(messages);
  });
});

describe('omitAttachmentData', () => {
  it('drops the data of every file part and keeps name and type', () => {
    const [stored] = omitAttachmentData([fileMessage('u1', 'data:image/png;base64,AAAA')]);
    expect(stored!.parts[1]).toEqual({ type: 'file', mediaType: 'image/png', url: '', filename: 'u1.png' });
  });
});
