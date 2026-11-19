/**
 * Chat attachment limits and helpers shared by the React composer and the
 * server handler, so client and server checks cannot drift. Dependency-free.
 */

export const DEFAULT_ATTACHMENT_MEDIA_TYPES: ReadonlyArray<string> = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
]);
/** Files per message. */
export const DEFAULT_ATTACHMENT_MAX_FILES = 10;
/** Decoded bytes per file (20 MB). */
export const DEFAULT_ATTACHMENT_MAX_FILE_BYTES = 20_000_000;

/** File parts whose data was dropped (old turns, stored sessions) carry an empty `url`. */
export function isOmittedAttachmentUrl(url: unknown): boolean {
  return url === '';
}

/** Stable id the chat gives each attached file, so the model can name it later. */
export const CHAT_ATTACHMENT_ID_PATTERN = /^att_[A-Za-z0-9_-]{16,64}$/;

export function isChatAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && CHAT_ATTACHMENT_ID_PATTERN.test(value);
}

export function createChatAttachmentId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `att_${uuid.replaceAll('-', '')}`;
  let random = '';
  for (let index = 0; index < 32; index++) random += Math.floor(Math.random() * 36).toString(36);
  return `att_${random}`;
}

/** The attachment id a file part carries in its provider metadata, if it is valid. */
export function attachmentIdOf(part: unknown): string | undefined {
  if (typeof part !== 'object' || part === null) return undefined;
  const metadata = (part as { providerMetadata?: { glirastes?: { attachmentId?: unknown } } }).providerMetadata;
  const id = metadata?.glirastes?.attachmentId;
  return isChatAttachmentId(id) ? id : undefined;
}

/** Text that stands in for a file part once its data is no longer sent. */
export function attachmentPlaceholderText(filename?: string, id?: string): string {
  const name = filename?.replace(/[[\]\r\n]/g, '').trim() || 'file';
  return isChatAttachmentId(id) ? `[attachment ${id}: ${name}]` : `[attachment: ${name}]`;
}

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);
const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

/** The media type the leading bytes prove, for the formats that have a signature. */
export function sniffMediaType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(bytes, ascii('%PDF-'))) return 'application/pdf';
  return undefined;
}

/** Media types `sniffMediaType` can confirm. */
export const SNIFFABLE_MEDIA_TYPES: ReadonlyArray<string> = Object.freeze([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf',
]);

export interface ParsedDataUrl {
  /** Lower-case media type declared in the URL ('' when absent). */
  mediaType: string;
  decodedBytes: number;
  /** First decoded bytes, enough to sniff the format. */
  head: Uint8Array;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A `data:…;base64,` URL, or null for anything else (other schemes, non-base64 data). */
export function parseDataUrl(url: string): ParsedDataUrl | null {
  if (!url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const params = url.slice(5, comma).split(';');
  if (params.at(-1)?.toLowerCase() !== 'base64') return null;
  const payload = url.slice(comma + 1);
  if (payload.length % 4 !== 0 || !BASE64.test(payload)) return null;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  let head: Uint8Array;
  try {
    const decoded = atob(payload.slice(0, 24));
    head = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
  return {
    mediaType: (params[0] ?? '').trim().toLowerCase(),
    decodedBytes: (payload.length / 4) * 3 - padding,
    head,
  };
}
