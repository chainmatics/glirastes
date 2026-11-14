import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ATTACHMENT_MAX_FILE_BYTES,
  DEFAULT_ATTACHMENT_MAX_FILES,
  DEFAULT_ATTACHMENT_MEDIA_TYPES,
  attachmentPlaceholderText,
  isOmittedAttachmentUrl,
  parseDataUrl,
  sniffMediaType,
} from '../attachments.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

describe('attachment contract', () => {
  it('has generous defaults', () => {
    expect(DEFAULT_ATTACHMENT_MEDIA_TYPES).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);
    expect(DEFAULT_ATTACHMENT_MAX_FILES).toBe(10);
    expect(DEFAULT_ATTACHMENT_MAX_FILE_BYTES).toBe(20_000_000);
  });

  it('sniffs the known signatures', () => {
    expect(sniffMediaType(PNG)).toBe('image/png');
    expect(sniffMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMediaType(new TextEncoder().encode('GIF89a...'))).toBe('image/gif');
    expect(sniffMediaType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffMediaType(new TextEncoder().encode('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffMediaType(new TextEncoder().encode('<svg'))).toBeUndefined();
  });

  it('parses a base64 data URL with its decoded size and head bytes', () => {
    const parsed = parseDataUrl(`data:image/png;base64,${b64(PNG)}`);
    expect(parsed).toMatchObject({ mediaType: 'image/png', decodedBytes: PNG.length });
    expect(parsed && sniffMediaType(parsed.head)).toBe('image/png');
    expect(parseDataUrl(`data:image/png;name=a.png;base64,${b64(PNG)}`)?.mediaType).toBe('image/png');
    expect(parseDataUrl('data:,hello')).toBeNull();
    expect(parseDataUrl('data:image/png;base64,***')).toBeNull();
    expect(parseDataUrl('https://example.com/a.png')).toBeNull();
  });

  it('counts padding when computing the decoded size', () => {
    expect(parseDataUrl(`data:text/plain;base64,${btoa('ab')}`)?.decodedBytes).toBe(2);
    expect(parseDataUrl(`data:text/plain;base64,${btoa('abcd')}`)?.decodedBytes).toBe(4);
  });

  it('names omitted attachments', () => {
    expect(isOmittedAttachmentUrl('')).toBe(true);
    expect(isOmittedAttachmentUrl('data:image/png;base64,AA==')).toBe(false);
    expect(attachmentPlaceholderText('scan.pdf')).toBe('[attachment: scan.pdf]');
    expect(attachmentPlaceholderText()).toBe('[attachment: file]');
  });
});
